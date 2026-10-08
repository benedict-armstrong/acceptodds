import { describe, expect, it } from 'vitest';
import { percentAhead, placeIn } from '@/lib/leaderboard';

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
