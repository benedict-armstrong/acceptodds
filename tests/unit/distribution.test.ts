import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { bandwidth, countBelow, density, niceTicks, quantile, rootScaled } from '@/lib/distribution';

const sorted = (xs: number[]) => [...xs].sort((a, b) => a - b);

describe('density', () => {
  it('integrates to about 1 and peaks near the mode', () => {
    const values = sorted([900, 950, 1000, 1000, 1000, 1010, 1050, 1100]);
    const d = density(values, 400);
    const dx = (d.domain[1] - d.domain[0]) / (d.xs.length - 1);
    const area = d.ys.reduce((a, y) => a + y * dx, 0);
    expect(area).toBeGreaterThan(0.98);
    expect(area).toBeLessThan(1.02);
    const peak = d.xs[d.ys.indexOf(Math.max(...d.ys))];
    expect(Math.abs(peak - 1000)).toBeLessThan(30);
  });

  it('draws a bump for a field of identical values', () => {
    const d = density([1000, 1000, 1000]);
    expect(d.bandwidth).toBeGreaterThan(0);
    expect(d.ys.every(Number.isFinite)).toBe(true);
    expect(Math.max(...d.ys)).toBeGreaterThan(0);
  });

  it('always puts the included point on the chart', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: -1e6, max: 1e7 }), { minLength: 1, maxLength: 50 }),
        fc.integer({ min: -1e6, max: 1e7 }),
        (xs, you) => {
          const d = density(sorted(xs), 20, you);
          expect(d.domain[0]).toBeLessThanOrEqual(Math.min(...xs, you));
          expect(d.domain[1]).toBeGreaterThanOrEqual(Math.max(...xs, you));
          expect(d.ys.every((y) => Number.isFinite(y) && y >= 0)).toBe(true);
        },
      ),
    );
  });
});

describe('helpers', () => {
  it('quantile interpolates', () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantile([7], 0.9)).toBe(7);
  });

  it('bandwidth is positive', () => {
    expect(bandwidth([5])).toBeGreaterThan(0);
    expect(bandwidth([0, 0])).toBeGreaterThan(0);
  });

  it('countBelow counts strictly lower values', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 0, max: 20 })), fc.integer({ min: -1, max: 21 }), (xs, x) => {
        const s = sorted(xs);
        expect(countBelow(s, x)).toBe(s.filter((v) => v < x).length);
      }),
    );
  });

  it('niceTicks are round, ordered and in range', () => {
    expect(niceTicks(0, 1000, 4)).toEqual([0, 500, 1000]);
    expect(niceTicks(873, 1219, 3)).toEqual([1000, 1200]);
    fc.assert(
      fc.property(
        fc.double({ min: -1e6, max: 1e6, noNaN: true }),
        fc.double({ min: 1, max: 1e6, noNaN: true }),
        (lo, span) => {
          const ts = niceTicks(lo, lo + span, 4);
          expect(ts.length).toBeGreaterThan(0);
          expect(ts.length).toBeLessThanOrEqual(10);
          for (const [i, t] of ts.entries()) {
            expect(t).toBeGreaterThanOrEqual(lo - span * 1e-6);
            expect(t).toBeLessThanOrEqual(lo + span + span * 1e-6);
            if (i > 0) expect(t).toBeGreaterThan(ts[i - 1]);
          }
        },
      ),
    );
  });
});

describe('bandwidth floor', () => {
  it('a crowd at one value does not shrink the kernel to a spike', () => {
    const values = sorted([...Array.from({ length: 100 }, (_, i) => 995 + (i % 10)), 250, 1500, 2050]);
    expect(bandwidth(values)).toBeGreaterThanOrEqual((2050 - 250) / 20);
  });
});

describe('rootScaled', () => {
  it('peaks at 1, keeps the order, and lifts small bumps', () => {
    expect(rootScaled([0, 1, 4, 100])).toEqual([0, 0.1, 0.2, 1]);
    expect(rootScaled([0, 0])).toEqual([0, 0]);
  });
});
