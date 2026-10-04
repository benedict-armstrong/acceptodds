import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { dotScale, headlineRgb, LIKELIHOOD_RGB, MAP_NONE, MAP_SIZE, normalise, topicLabels } from '@/lib/map';

describe('normalise', () => {
  it('fills the longer axis, keeps the aspect and centres the shorter', () => {
    const p = normalise([
      { x: 10, y: 0 },
      { x: 30, y: 5 },
    ]);
    expect([...p]).toEqual([0, 375, MAP_SIZE, 625]);
  });

  it('puts every point inside the map, whatever the supplier’s units', () => {
    const point = fc.record({
      x: fc.double({ min: -1e6, max: 1e6, noNaN: true }),
      y: fc.double({ min: -1e6, max: 1e6, noNaN: true }),
    });
    fc.assert(
      fc.property(fc.array(point, { minLength: 1, maxLength: 50 }), (points) => {
        for (const v of normalise(points)) expect(v >= -1e-3 && v <= MAP_SIZE + 1e-3).toBe(true);
      }),
    );
  });

  it('handles a single point and an empty map', () => {
    expect(normalise([])).toHaveLength(0);
    expect([...normalise([{ x: 3, y: 3 }])]).toEqual([MAP_SIZE / 2, MAP_SIZE / 2]);
  });

  it('does not overflow the stack on a large map', () => {
    const points = Array.from({ length: 300_000 }, (_, i) => ({ x: i, y: -i }));
    expect(normalise(points)).toHaveLength(600_000);
  });
});

describe('topicLabels', () => {
  const positions = Float32Array.from([0, 0, 10, 10, 2, 2, 500, 500, 100, 100]);
  const names = new Map([
    [0, 'zero'],
    [1, 'one'],
  ]);

  it('labels a grouping at the median of its points, ignoring a stray', () => {
    const labels = topicLabels(positions, [0, 0, 0, 0, 1], names, 2);
    expect(labels).toEqual([{ number: 0, text: 'zero', x: 10, y: 10, size: 4 }]);
  });

  it('skips groupings without a name or a point', () => {
    expect(topicLabels(positions, [null, 7, null, 7, 1], names, 1)).toEqual([
      { number: 1, text: 'one', x: 100, y: 100, size: 1 },
    ]);
  });
});

describe('colours and dots', () => {
  it('colours by the site’s likelihood bands and leaves an unpriced paper grey', () => {
    expect(headlineRgb(0.8)).toEqual(LIKELIHOOD_RGB.accept);
    expect(headlineRgb(0.5)).toEqual(LIKELIHOOD_RGB['toss-up']);
    expect(headlineRgb(0.1)).toEqual(LIKELIHOOD_RGB.reject);
    expect(headlineRgb(null)).toEqual(MAP_NONE);
  });

  it('grows dots with zoom, never below the opening size, and caps them', () => {
    expect(dotScale(-2, 0)).toBe(1);
    expect(dotScale(0, 0)).toBe(1);
    expect(dotScale(2, 0)).toBeCloseTo(2.25);
    expect(dotScale(20, 0)).toBe(6);
  });
});
