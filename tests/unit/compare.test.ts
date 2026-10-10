import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { meanMicro, medianMicro, sharedDensities, summarize } from '@/lib/compare';

describe('meanMicro and medianMicro', () => {
  it('are null for an empty field', () => {
    expect(meanMicro([])).toBeNull();
    expect(medianMicro([])).toBeNull();
  });

  it('average exactly, rounding toward zero', () => {
    expect(meanMicro([1n, 2n])).toBe(1n);
    expect(meanMicro([-1n, -2n])).toBe(-1n);
    expect(medianMicro([5n, 1n, 3n])).toBe(3n);
    expect(medianMicro([4n, 1n, 3n, 2n])).toBe(2n);
  });

  it('lie between the extremes', () => {
    fc.assert(
      fc.property(
        fc.array(fc.bigInt({ min: -(10n ** 12n), max: 10n ** 12n }), { minLength: 1, maxLength: 40 }),
        (xs) => {
          const lo = xs.reduce((a, v) => (v < a ? v : a));
          const hi = xs.reduce((a, v) => (v > a ? v : a));
          for (const m of [meanMicro(xs)!, medianMicro(xs)!]) {
            expect(m >= lo && m <= hi).toBe(true);
          }
        },
      ),
    );
  });
});

describe('summarize', () => {
  it('counts and averages each column', () => {
    const s = summarize([
      { netWorthMicro: 1000n, unrealizedPnlMicro: 10n, settledPnlMicro: 0n },
      { netWorthMicro: 3000n, unrealizedPnlMicro: -30n, settledPnlMicro: 4n },
    ]);
    expect(s).toEqual({
      traders: 2,
      meanNetWorthMicro: 2000n,
      medianNetWorthMicro: 2000n,
      meanUnrealizedPnlMicro: -10n,
      meanSettledPnlMicro: 2n,
    });
  });
});

describe('sharedDensities', () => {
  it('puts every curve on one domain, the highest peak at 1', () => {
    const d = sharedDensities([
      [900, 1000, 1100],
      [1950, 2000, 2000, 2050],
    ]);
    expect(d.domain[0]).toBeLessThan(900);
    expect(d.domain[1]).toBeGreaterThan(2050);
    expect(d.curves).toHaveLength(2);
    expect(Math.max(...d.curves.flat())).toBeCloseTo(1);
    // The narrower field stands taller.
    expect(Math.max(...d.curves[1])).toBeGreaterThan(Math.max(...d.curves[0]));
  });

  it('leaves an empty field empty', () => {
    expect(sharedDensities([[], [1000]]).curves[0]).toEqual([]);
    expect(sharedDensities([[], []])).toEqual({ domain: [0, 0], curves: [[], []] });
  });
});
