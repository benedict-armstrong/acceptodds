import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { floored, jevScore, normalQuantile, PRICE_FLOOR, ranked } from '@/server/jev';

describe('floored', () => {
  it('keeps every price at or above the floor, summing to 1', () => {
    fc.assert(
      fc.property(fc.array(fc.double({ min: 0, max: 10, noNaN: true }), { minLength: 2, maxLength: 4 }), (raw) => {
        const p = floored(raw);
        if (raw.reduce((a, x) => a + x, 0) <= 0) return expect(p).toBeNull();
        expect(p!.reduce((a, x) => a + x, 0)).toBeCloseTo(1, 9);
        for (const x of p!) expect(x).toBeGreaterThanOrEqual(PRICE_FLOOR - 1e-12);
      }),
    );
  });

  it('mixes a binary answer with the floor', () => {
    expect(floored([0.9, 0.1])!.map((x) => +x.toFixed(6))).toEqual([0.86, 0.14]);
    expect(floored([1, 0])!.map((x) => +x.toFixed(6))).toEqual([0.95, 0.05]);
  });
});

describe('normalQuantile', () => {
  it('inverts the standard normal', () => {
    expect(normalQuantile(0.5)).toBeCloseTo(0, 9);
    expect(normalQuantile(0.975)).toBeCloseTo(1.959964, 5);
    expect(normalQuantile(0.1)).toBeCloseTo(-1.281552, 5);
    expect(normalQuantile(0.001)).toBeCloseTo(-3.090232, 5);
    expect(normalQuantile(0.999)).toBeCloseTo(3.090232, 5);
  });
});

describe('ranked', () => {
  const prior = [0.32, 0.68];
  const logit = (p: number) => Math.log(p / (1 - p));
  // JEV answering 50%..95% Accept, evenly: a generous model, as it is.
  const reference = Array.from({ length: 99 }, (_, i) => jevScore([0.5 + (0.45 * i) / 98, 0.5 - (0.45 * i) / 98]));

  it('opens the median answer at the prior, however generous JEV is', () => {
    const median = reference[49];
    const a = 1 / (1 + Math.exp(-median));
    expect(ranked([a, 1 - a], reference, prior, 0.5)![0]).toBeCloseTo(0.32, 12);
  });

  it('moves the log-odds from the prior by spread × the answer’s normal score', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0.001, max: 0.999, noNaN: true }),
        fc.double({ min: 0.1, max: 0.8, noNaN: true }),
        (a, spread) => {
          const p = ranked([a, 1 - a], reference, prior, spread)!;
          expect(p[0] + p[1]).toBeCloseTo(1, 12);
          const below = reference.filter((r) => r < jevScore([a, 1 - a])).length;
          const equal = reference.filter((r) => r === jevScore([a, 1 - a])).length;
          const u = (below + equal / 2 + 0.5) / (reference.length + 1);
          expect(logit(p[0]) - logit(0.32)).toBeCloseTo(spread * normalQuantile(u), 9);
        },
      ),
    );
  });

  it('is monotone in the answer and bounded by the sample size', () => {
    const at = (a: number) => ranked([a, 1 - a], reference, prior, 0.5)![0];
    expect(at(0.3)).toBeLessThan(at(0.7));
    expect(at(0.7)).toBeLessThan(at(0.99));
    expect(at(0)).toBeGreaterThan(0.1);
    expect(at(1)).toBeLessThan(0.65);
  });

  it('gives tied answers the middle of their run', () => {
    const tied = [-1, 0, 0, 0, 1];
    expect(ranked([0.5, 0.5], tied, [0.5, 0.5], 1)![0]).toBeCloseTo(0.5, 12);
  });

  it('shares the headline among the other outcomes as JEV does, and keeps the floor', () => {
    const p = ranked([0.6, 0.2, 0.2], reference, [0.2, 0.2, 0.6], 0.5)!;
    expect(p.reduce((a, x) => a + x, 0)).toBeCloseTo(1, 12);
    expect(p[0] / p[1]).toBeCloseTo(3, 9);
    const sure = ranked([1, 0, 0], reference, [0.2, 0.2, 0.6], 3)!;
    expect(sure.reduce((a, x) => a + x, 0)).toBeCloseTo(1, 12);
    for (const x of sure) expect(x).toBeGreaterThanOrEqual(PRICE_FLOOR - 1e-12);
  });

  it('is null without a reference', () => {
    expect(ranked([0.5, 0.5], [], prior, 0.5)).toBeNull();
  });
});
