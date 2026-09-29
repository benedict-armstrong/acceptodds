import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { digestDay, headlineOrdinal, minMovePp, moveOf, movedEnough, renderDigest } from '@/lib/digest';

describe('headlineOrdinal', () => {
  it('is the first outcome of a binary market, whatever its price', () => {
    expect(headlineOrdinal([0.2, 0.8])).toBe(0);
  });
  it('is the favourite of a multi-outcome market, lowest ordinal on a tie', () => {
    expect(headlineOrdinal([0.2, 0.5, 0.3])).toBe(1);
    expect(headlineOrdinal([0.4, 0.4, 0.2])).toBe(0);
  });
  it('follows the same outcome then and now', () => {
    expect(moveOf([0.5, 0.25, 0.25], [0.2, 0.3, 0.5])).toEqual({ ordinal: 2, then: 0.25, now: 0.5 });
  });
});

describe('movedEnough', () => {
  it('compares the absolute move in percentage points, inclusive', () => {
    expect(movedEnough({ then: 0.5, now: 0.55 }, 5)).toBe(true);
    expect(movedEnough({ then: 0.55, now: 0.5 }, 5)).toBe(true);
    expect(movedEnough({ then: 0.5, now: 0.549 }, 5)).toBe(false);
    expect(movedEnough({ then: 0.3, now: 0.3 }, 5)).toBe(false);
  });
  it('is symmetric in direction', () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 1, noNaN: true }), fc.double({ min: 0, max: 1, noNaN: true }), fc.double({ min: 0.1, max: 50, noNaN: true }), (a, b, t) =>
        movedEnough({ then: a, now: b }, t) === movedEnough({ then: b, now: a }, t),
      ),
    );
  });
});

describe('minMovePp', () => {
  it('defaults to 5 and rejects nonsense', () => {
    expect(minMovePp(undefined)).toBe(5);
    expect(minMovePp('')).toBe(5);
    expect(minMovePp('abc')).toBe(5);
    expect(minMovePp('-1')).toBe(5);
    expect(minMovePp('2.5')).toBe(2.5);
  });
});

describe('digestDay', () => {
  it('is the calendar day in the given time zone', () => {
    // 23:30 UTC on 1 March is already 2 March in Zurich (UTC+1).
    const t = new Date('2027-03-01T23:30:00Z');
    expect(digestDay(t, 'UTC')).toBe('2027-03-01');
    expect(digestDay(t, 'Europe/Zurich')).toBe('2027-03-02');
  });
});

describe('renderDigest', () => {
  const item = (slug: string, then: number, now: number, extra = {}) => ({
    ordinal: 0,
    then,
    now,
    title: `Title ${slug}`,
    slug,
    question: `Q ${slug}?`,
    outcomeLabel: 'YES',
    binary: true,
    ...extra,
  });

  it('lists old → new, biggest move first, with links and a way out', () => {
    const { subject, text } = renderDigest([item('a', 0.5, 0.56), item('b', 0.7, 0.4)], 'https://x.test/');
    expect(subject).toBe('acceptodds: 2 followed papers moved in the last 24 hours');
    expect(text).toContain('Q a?: 50% → 56% (+6 pp)');
    expect(text).toContain('Q b?: 70% → 40% (−30 pp)');
    expect(text.indexOf('Title b')).toBeLessThan(text.indexOf('Title a'));
    expect(text).toContain('https://x.test/papers/a');
    expect(text).toContain('https://x.test/profile');
  });

  it('names the outcome for a multi-outcome market', () => {
    const { text } = renderDigest([item('m', 0.3, 0.5, { binary: false, outcomeLabel: 'Poster' })], 'https://x.test');
    expect(text).toContain('Q m? (Poster): 30% → 50%');
  });
});
