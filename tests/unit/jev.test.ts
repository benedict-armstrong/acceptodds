import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { calibrated, floored, PRICE_FLOOR } from '@/server/jev';

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

describe('calibrated', () => {
  const typical = [0.77, 0.23];
  const prior = [0.32, 0.68];
  const logit = (p: number) => Math.log(p / (1 - p));

  it('opens a typical answer at the prior', () => {
    expect(calibrated(typical, typical, prior)![0]).toBeCloseTo(0.32, 12);
  });

  it('moves a binary answer from the prior by its log-odds from the typical one', () => {
    fc.assert(
      fc.property(fc.double({ min: 0.001, max: 0.999, noNaN: true }), (a) => {
        const p = calibrated([a, 1 - a], typical, prior)!;
        expect(p[0] + p[1]).toBeCloseTo(1, 12);
        expect(logit(p[0]) - logit(0.32)).toBeCloseTo(logit(a) - logit(0.77), 9);
      }),
    );
  });

  it('is null when nothing is left to normalize', () => {
    expect(calibrated([0, 0], typical, prior)).toBeNull();
  });
});
