import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  cost,
  costToTrade,
  liquidityFor,
  maxSubsidy,
  prices,
  sharesForCost,
  SUBSIDY_FRACTION,
} from '@/lib/lmsr';
import { costToMicro } from '@/lib/money';

/**
 * These five properties are the real specification of `lib/lmsr.ts`. They run
 * before any database code exists, on purpose: if the maths is wrong,
 * everything downstream is wrong quietly.
 */
const NUM_RUNS = 1000;

/**
 * LMSR is scale-invariant — `cost(k*q, k*b) === k * cost(q, b)` — so
 * generating `b` over nine orders of magnitude and then the share vector as
 * multiples of `b` covers the whole meaningful space. `spread` bounds
 * `|q_i| / b`.
 *
 * The spread is bounded rather than unbounded for a floating-point reason, not
 * a mathematical one: a double cannot hold a probability of `e^-40` next to
 * one of `1 - e^-40`, so the `1` end rounds to exactly 1.0 and strict
 * statements about open intervals stop being testable. The maths is fine out
 * there; `cost` is shift-invariant precisely so that it survives it.
 */
function marketArb(spread: number, maxOutcomes = 8) {
  return fc
    .record({
      b: fc.double({ min: 1e-3, max: 1e9, noNaN: true }),
      rel: fc.array(fc.double({ min: -spread, max: spread, noNaN: true }), {
        minLength: 2,
        maxLength: maxOutcomes,
      }),
    })
    .map(({ b, rel }) => ({ b, shares: rel.map((r) => r * b) }));
}

describe('lmsr property 1 — prices are a probability distribution', () => {
  it('sums to 1 and every element is strictly inside (0, 1)', () => {
    fc.assert(
      fc.property(marketArb(15), ({ b, shares }) => {
        const p = prices(shares, b);

        expect(p).toHaveLength(shares.length);
        let sum = 0;
        for (const x of p) {
          expect(Number.isFinite(x)).toBe(true);
          expect(x).toBeGreaterThan(0);
          expect(x).toBeLessThan(1);
          sum += x;
        }
        expect(Math.abs(sum - 1)).toBeLessThanOrEqual(1e-9);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('survives a decisively moved market without overflowing', () => {
    // The shift-invariant form is what makes this finite. Strictness is not
    // claimed here: at this spread the top price rounds to exactly 1.0.
    fc.assert(
      fc.property(marketArb(5000), ({ b, shares }) => {
        const p = prices(shares, b);
        expect(Number.isFinite(cost(shares, b))).toBe(true);
        let sum = 0;
        for (const x of p) {
          expect(Number.isFinite(x)).toBe(true);
          expect(x).toBeGreaterThanOrEqual(0);
          expect(x).toBeLessThanOrEqual(1);
          sum += x;
        }
        expect(Math.abs(sum - 1)).toBeLessThanOrEqual(1e-9);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

describe('lmsr property 2 — costToTrade is path independent', () => {
  it('buying 10 then 10 costs the same as buying 20', () => {
    fc.assert(
      fc.property(
        marketArb(15),
        fc.double({ min: -10, max: 10, noNaN: true }),
        fc.double({ min: -10, max: 10, noNaN: true }),
        fc.nat(),
        ({ b, shares }, relA, relB, rawIndex) => {
          const i = rawIndex % shares.length;
          const a = relA * b;
          const c = relB * b;

          const first = costToTrade(shares, i, a, b);
          const midway = shares.slice();
          midway[i] += a;
          const second = costToTrade(midway, i, c, b);
          const together = costToTrade(shares, i, a + c, b);

          // Tolerance is relative to `b` because the costs themselves are of
          // order `b`, and `costToTrade` is a difference of two such numbers.
          expect(Math.abs(first + second - together)).toBeLessThanOrEqual(1e-9 * b);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

describe('lmsr property 3 — trading moves the price the right way', () => {
  it('buying strictly raises that outcome price; selling strictly lowers it', () => {
    fc.assert(
      fc.property(
        marketArb(8),
        fc.double({ min: 0.01, max: 10, noNaN: true }),
        fc.nat(),
        ({ b, shares }, relDelta, rawIndex) => {
          const i = rawIndex % shares.length;
          const delta = relDelta * b;
          const before = prices(shares, b)[i];

          const bought = shares.slice();
          bought[i] += delta;
          expect(prices(bought, b)[i]).toBeGreaterThan(before);

          const sold = shares.slice();
          sold[i] -= delta;
          expect(prices(sold, b)[i]).toBeLessThan(before);

          // And the cost has the matching sign: a buy costs, a sell pays.
          expect(costToTrade(shares, i, delta, b)).toBeGreaterThan(0);
          expect(costToTrade(shares, i, -delta, b)).toBeLessThan(0);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

describe('lmsr property 4 — a round trip loses money', () => {
  /**
   * A caveat that matters, because the plan states this property in a form
   * that is false.
   *
   * In a fee-free LMSR, `C` is a function of the share vector alone, so buying
   * `n` and immediately selling `n` returns the share vector to where it
   * started and the proceeds are **exactly** what the buy cost — not strictly
   * less. There is no spread to lose to. Asserting a strict real-valued loss
   * would assert something untrue, and a test that passed would mean the cost
   * function had stopped being path independent (property 2).
   *
   * What is strictly true, and is what invariant §1.1 is actually about:
   *
   *   (a) the position's **mark** (`shares x current price`) strictly exceeds
   *       what selling it would pay, because the price moves against the
   *       seller on the way out. This is why `quote()` is the only honest
   *       answer to "what is this worth";
   *   (b) in the integers a trader is actually charged, the round trip never
   *       returns more than it cost, because the sub-micro-unit remainder is
   *       always rounded to the venue (`money.costToMicro`).
   */
  it('the mark strictly exceeds the exit proceeds, and the integer round trip never profits', () => {
    fc.assert(
      fc.property(
        marketArb(8),
        fc.double({ min: 0.05, max: 10, noNaN: true }),
        fc.nat(),
        ({ b, shares }, relDelta, rawIndex) => {
          const i = rawIndex % shares.length;
          const delta = relDelta * b;

          const buyCost = costToTrade(shares, i, delta, b);
          const held = shares.slice();
          held[i] += delta;

          // (a) mark > exit proceeds, strictly.
          const mark = delta * prices(held, b)[i];
          const exitProceeds = -costToTrade(held, i, -delta, b);
          expect(exitProceeds).toBeLessThan(mark);

          // The real-valued round trip is exactly flat, which is what makes
          // (a) the honest statement of the invariant.
          expect(Math.abs(exitProceeds - buyCost)).toBeLessThanOrEqual(1e-9 * b);

          // (b) in charged micro-units the round trip never returns more than
          // it cost. `costToMicro` rounds every cost in the house's favour, so
          // buy + sell is a non-negative number of micro-units kept by the
          // venue.
          if (Math.abs(buyCost) < Number.MAX_SAFE_INTEGER / 4) {
            const paid = costToMicro(buyCost);
            const received = -costToMicro(-exitProceeds);
            expect(received <= paid).toBe(true);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

describe('lmsr property 5 — the venue subsidy is bounded by b * ln(n)', () => {
  it('never pays out more than it took in plus b * ln(n), whatever the field does', () => {
    fc.assert(
      fc.property(marketArb(15), ({ b, shares }) => {
        const n = shares.length;
        const opening = new Array<number>(n).fill(0);
        const revenue = cost(shares, b) - cost(opening, b);

        // Settlement pays 1 unit per share of the winning outcome. The venue's
        // worst case is whichever outcome it is dearest to have to pay.
        const worstPayout = Math.max(...shares);
        const subsidy = worstPayout - revenue;

        expect(subsidy).toBeLessThanOrEqual(maxSubsidy(b, n) + 1e-9 * b);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

describe('sharesForCost — the inverse of a buy', () => {
  it('buys exactly the budget, and more budget buys more shares', () => {
    fc.assert(
      fc.property(
        marketArb(10).chain((m) =>
          fc.record({
            m: fc.constant(m),
            i: fc.nat({ max: m.shares.length - 1 }),
            // Spends from a sliver of b to 20 b: a small bet to a pinned price.
            x: fc.double({ min: 1e-6, max: 20, noNaN: true }),
          }),
        ),
        ({ m: { b, shares }, i, x }) => {
          const budget = x * b;
          const delta = sharesForCost(shares, i, budget, b);
          expect(delta).toBeGreaterThan(0);
          // costToTrade is a difference of two costs of order b, so its own
          // error is absolute in b as well as relative in the budget.
          expect(Math.abs(costToTrade(shares, i, delta, b) - budget)).toBeLessThanOrEqual(budget * 1e-9 + b * 1e-12);
          expect(sharesForCost(shares, i, budget * 1.5, b)).toBeGreaterThan(delta);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('buys nothing for nothing, and refuses a negative budget', () => {
    expect(sharesForCost([0, 0], 0, 0, 100)).toBe(0);
    expect(() => sharesForCost([0, 0], 0, -1, 100)).toThrow(RangeError);
    expect(() => sharesForCost([0, 0], 2, 1, 100)).toThrow(RangeError);
  });
});

describe('liquidityFor', () => {
  it('spends exactly SUBSIDY_FRACTION of the field capital on subsidy', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 1, max: 1e12, noNaN: true }),
        fc.integer({ min: 1, max: 10_000 }),
        fc.integer({ min: 2, max: 32 }),
        (balance, traders, outcomes) => {
          const b = liquidityFor(balance, traders, outcomes);
          expect(b).toBeGreaterThan(0);
          const expected = SUBSIDY_FRACTION * balance * traders;
          expect(Math.abs(maxSubsidy(b, outcomes) - expected)).toBeLessThanOrEqual(
            1e-9 * expected,
          );
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('refuses a one-outcome market', () => {
    expect(() => liquidityFor(1000, 10, 1)).toThrow();
  });
});
