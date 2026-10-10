import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { costBasis, soldBasis, type Fill } from '@/lib/cost-basis';

/** A history a trader could have made: only ever selling what they hold. */
const history = fc
  .array(
    fc.record({
      buy: fc.boolean(),
      shares: fc.bigInt({ min: 1n, max: 10n ** 9n }),
      price: fc.integer({ min: 1, max: 999 }),
    }),
    {
      maxLength: 30,
    },
  )
  .map((steps) => {
    const fills: Fill[] = [];
    let held = 0n;
    for (const s of steps) {
      if (s.buy) {
        fills.push({ sharesMicro: s.shares, costMicro: (s.shares * BigInt(s.price)) / 1000n + 1n });
        held += s.shares;
      } else if (held > 0n) {
        const n = s.shares > held ? held : s.shares;
        fills.push({ sharesMicro: -n, costMicro: -((n * BigInt(s.price)) / 1000n) });
        held -= n;
      }
    }
    return { fills, held };
  });

describe('costBasis', () => {
  it('buys add their cost; the held shares match the fills', () => {
    expect(costBasis([])).toEqual({ sharesMicro: 0n, basisMicro: 0n });
    expect(
      costBasis([
        { sharesMicro: 10n, costMicro: 4n },
        { sharesMicro: 10n, costMicro: 6n },
      ]),
    ).toEqual({ sharesMicro: 20n, basisMicro: 10n });
  });

  it('a sell keeps the average price of what is left, whatever it sold for', () => {
    const r = costBasis([
      { sharesMicro: 100n, costMicro: 40n },
      { sharesMicro: -25n, costMicro: -90n },
    ]);
    expect(r).toEqual({ sharesMicro: 75n, basisMicro: 30n });
  });

  it('a position sold out and bought again starts afresh', () => {
    const r = costBasis([
      { sharesMicro: 100n, costMicro: 40n },
      { sharesMicro: -100n, costMicro: -35n },
      { sharesMicro: 50n, costMicro: 30n },
    ]);
    expect(r).toEqual({ sharesMicro: 50n, basisMicro: 30n });
  });

  it('never goes negative, never exceeds what the buys cost, and is 0 exactly when nothing is held', () => {
    fc.assert(
      fc.property(history, ({ fills, held }) => {
        const r = costBasis(fills);
        const paid = fills.reduce((s, f) => (f.sharesMicro > 0n ? s + f.costMicro : s), 0n);
        expect(r.sharesMicro).toBe(held);
        expect(r.basisMicro).toBeGreaterThanOrEqual(0n);
        expect(r.basisMicro).toBeLessThanOrEqual(paid);
        if (held === 0n) expect(r.basisMicro).toBe(0n);
      }),
      { numRuns: 1000 },
    );
  });
});

describe('soldBasis', () => {
  it('is all of the basis for the whole holding, else its fraction, rounded down', () => {
    expect(soldBasis(30_000_000n, 3_000_000n, 3_000_000n)).toBe(30_000_000n);
    expect(soldBasis(10n, 3n, 1n)).toBe(3n);
    expect(soldBasis(10n, 0n, 1n)).toBe(0n);
  });
});
