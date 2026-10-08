import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { leaderboardSegments, percentAhead, placeIn } from '@/lib/leaderboard';

describe('leaderboardSegments', () => {
  it('is the top ten and the focus with two either side', () => {
    expect(leaderboardSegments(100, 50)).toEqual([
      [0, 10],
      [48, 53],
    ]);
  });

  it('is just the top without a focus, or a short board whole', () => {
    expect(leaderboardSegments(100, null)).toEqual([[0, 10]]);
    expect(leaderboardSegments(4, null)).toEqual([[0, 4]]);
    expect(leaderboardSegments(0, null)).toEqual([]);
  });

  it('merges a focus near the top, and never hides a single row', () => {
    expect(leaderboardSegments(100, 3)).toEqual([[0, 10]]);
    expect(leaderboardSegments(100, 11)).toEqual([[0, 14]]);
    expect(leaderboardSegments(100, 12)).toEqual([[0, 15]]);
    // Row 10 alone between them: shown rather than hidden behind a "…".
    expect(leaderboardSegments(100, 13)).toEqual([[0, 16]]);
    expect(leaderboardSegments(100, 14)).toEqual([
      [0, 10],
      [12, 17],
    ]);
  });

  it('clips at the bottom', () => {
    expect(leaderboardSegments(30, 29)).toEqual([
      [0, 10],
      [27, 30],
    ]);
  });

  it('is ordered, disjoint, in range, and shows the focus', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 300 }), fc.nat(), (total, f) => {
        const focus = total === 0 ? null : f % total;
        const segs = leaderboardSegments(total, focus);
        for (const [i, [s, e]] of segs.entries()) {
          expect(s).toBeGreaterThanOrEqual(0);
          expect(e).toBeLessThanOrEqual(total);
          expect(s).toBeLessThan(e);
          if (i > 0) expect(s).toBeGreaterThan(segs[i - 1][1] + 1);
        }
        if (focus !== null) expect(segs.some(([s, e]) => s <= focus && focus < e)).toBe(true);
      }),
    );
  });
});

describe('percentAhead', () => {
  it('is the share of the others strictly below, rounded down', () => {
    expect(percentAhead(99, 100)).toBe(100);
    expect(percentAhead(0, 100)).toBe(0);
    expect(percentAhead(2, 4)).toBe(66);
    expect(percentAhead(0, 1)).toBeNull();
    // Decimals round down too: 2/3 is 66.6…%, never 66.7.
    expect(percentAhead(2, 4, 1)).toBe(66.6);
    expect(percentAhead(99, 100, 1)).toBe(100);
  });
});

describe('placeIn', () => {
  const field = [100n, 200n, 200n, 300n, 400n];

  it('ranks as the leaderboard does: one more than those strictly higher', () => {
    expect(placeIn(field, 400n)).toEqual({ rank: 1, fieldSize: 5, percentAhead: 100 });
    expect(placeIn(field, 200n)).toEqual({ rank: 3, fieldSize: 5, percentAhead: 25 });
    expect(placeIn(field, 100n)).toEqual({ rank: 5, fieldSize: 5, percentAhead: 0 });
  });

  it('places a figure between or beyond the snapshot’s', () => {
    expect(placeIn(field, 250n)).toEqual({ rank: 3, fieldSize: 5, percentAhead: 75 });
    expect(placeIn(field, 999n)).toMatchObject({ rank: 1 });
    expect(placeIn(field, 0n)).toEqual({ rank: 6, fieldSize: 6, percentAhead: 0 });
    expect(placeIn([], 5n)).toEqual({ rank: 1, fieldSize: 1, percentAhead: null });
  });
});
