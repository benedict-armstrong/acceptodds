import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { floored, PRICE_FLOOR } from '@/server/jev';

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
