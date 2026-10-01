import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { stepIndexAt } from '@/lib/chart';

describe('stepIndexAt', () => {
  it('holds a price until the next point', () => {
    const t = [10, 20, 20, 30];
    expect(stepIndexAt(t, 5)).toBe(0);
    expect(stepIndexAt(t, 10)).toBe(0);
    expect(stepIndexAt(t, 19)).toBe(0);
    expect(stepIndexAt(t, 20)).toBe(2);
    expect(stepIndexAt(t, 29)).toBe(2);
    expect(stepIndexAt(t, 99)).toBe(3);
  });

  it('is the last point at or before the time', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 1000 }), { minLength: 1 }),
        fc.integer({ min: 0, max: 1000 }),
        (raw, ms) => {
          const t = [...raw].sort((a, b) => a - b);
          const k = stepIndexAt(t, ms);
          const expected = t[0] > ms ? 0 : t.findLastIndex((v) => v <= ms);
          expect(k).toBe(expected);
        },
      ),
    );
  });
});
