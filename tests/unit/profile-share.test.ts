import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { profileShareText, STANDING_BAR_WIDTH, standingBar } from '@/lib/profile-share';

describe('standingBar', () => {
  it('marks the share of the field below, worst on the left', () => {
    expect(standingBar(0)).toBe(`[|${'-'.repeat(20)}]`);
    expect(standingBar(50)).toBe(`[${'#'.repeat(10)}|${'-'.repeat(10)}]`);
    expect(standingBar(100)).toBe(`[${'#'.repeat(20)}|]`);
  });

  it('rounds down, so it never flatters', () => {
    expect(standingBar(99)).toBe(`[${'#'.repeat(19)}|-]`);
    expect(standingBar(4)).toBe(`[|${'-'.repeat(20)}]`);
  });

  it('is plain ASCII of a fixed width, with one marker', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 100 }), (p) => {
        const bar = standingBar(p);
        expect(bar).toMatch(/^\[#*\|-*\]$/);
        expect(bar.length).toBe(STANDING_BAR_WIDTH + 3);
      }),
    );
  });
});

describe('profileShareText', () => {
  const base = { displayName: 'Ada Lovelace', handle: 'ada', site: 'acceptodds', url: 'https://x.test/people/ada' };

  it('is the name, the rank, the bar and the link', () => {
    expect(profileShareText({ ...base, standing: { rank: 12, fieldSize: 1340, percentAhead: 99 } })).toBe(
      [
        'Ada Lovelace (@ada) on acceptodds',
        'Top 1% of traders',
        `[${'#'.repeat(19)}|-]`,
        'https://x.test/people/ada',
      ].join('\n'),
    );
  });

  it('has no bar in a field of one, and no rank off the board', () => {
    expect(profileShareText({ ...base, standing: { rank: 1, fieldSize: 1, percentAhead: null } })).toBe(
      'Ada Lovelace (@ada) on acceptodds\nhttps://x.test/people/ada',
    );
    expect(profileShareText({ ...base, standing: null })).toBe(
      'Ada Lovelace (@ada) on acceptodds\nhttps://x.test/people/ada',
    );
  });
});
