import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  DIVERSITY,
  RECENCY,
  WEIGHT,
  relatedVotes,
  scoreCandidates,
  sourceWeights,
  topSources,
  MAX_SOURCES,
  vectorVotes,
  type Interaction,
  type InteractionKind,
} from '@/lib/recommend';

const at = (minute: number) => new Date(Date.UTC(2026, 9, 1, 0, minute));

describe('sourceWeights', () => {
  it('weights by kind and by order, newest first, whatever the gaps in time', () => {
    const w = sourceWeights([
      { listingId: 'old', kind: 'follow', at: at(0) },
      { listingId: 'new', kind: 'trade', at: at(60 * 24 * 365) },
    ]);
    expect(w.get('new')).toBe(WEIGHT.trade);
    expect(w.get('old')).toBeCloseTo(WEIGHT.follow * RECENCY);
  });

  it('sums kinds on one paper', () => {
    const w = sourceWeights([
      { listingId: 'p', kind: 'trade', at: at(2) },
      { listingId: 'p', kind: 'follow', at: at(1) },
    ]);
    expect(w.get('p')).toBeCloseTo(WEIGHT.trade + WEIGHT.follow * RECENCY);
  });

  it('does not depend on the input order', () => {
    const kinds = Object.keys(WEIGHT) as InteractionKind[];
    const interaction = fc.record({
      listingId: fc.constantFrom('a', 'b', 'c', 'd'),
      kind: fc.constantFrom(...kinds),
      at: fc.integer({ min: 0, max: 5 }).map(at),
    });
    fc.assert(
      fc.property(fc.array(interaction, { maxLength: 12 }), (xs: Interaction[]) => {
        const forward = sourceWeights(xs);
        const backward = sourceWeights([...xs].reverse());
        expect([...backward].sort()).toEqual([...forward].sort());
      }),
    );
  });
});

describe('topSources', () => {
  it('keeps the heaviest MAX_SOURCES', () => {
    const w = new Map(Array.from({ length: MAX_SOURCES + 5 }, (_, i) => [`p${String(i).padStart(3, '0')}`, i]));
    const top = topSources(w);
    expect(top).toHaveLength(MAX_SOURCES);
    expect(top[0]).toBe(`p${String(MAX_SOURCES + 4).padStart(3, '0')}`);
  });
});

describe('scoreCandidates', () => {
  it('never scores the viewer’s own papers', () => {
    const scores = scoreCandidates(
      new Map([
        ['a', 1],
        ['b', 1],
      ]),
      [
        ...relatedVotes([
          { source: 'a', target: 'b', score: 2 },
          { source: 'a', target: 'c', score: 1 },
        ]),
      ],
    );
    expect([...scores.keys()]).toEqual(['c']);
  });

  it('ranks a paper near several sources above one near a single source', () => {
    const scores = scoreCandidates(
      new Map([
        ['a', 1],
        ['b', 1],
      ]),
      [...vectorVotes('a', ['x', 'y']), ...vectorVotes('b', ['x'])],
    );
    expect(scores.get('x')!).toBeGreaterThan(scores.get('y')!);
  });

  it('damps a single source’s later neighbours', () => {
    const scores = scoreCandidates(new Map([['a', 1]]), [
      { source: 'a', target: 'x', strength: 1, via: 'related' },
      { source: 'a', target: 'y', strength: 1, via: 'related' },
    ]);
    expect([...scores.values()].sort()).toEqual([DIVERSITY, 1]);
  });

  it('counts a duplicated vote once', () => {
    const vote = { source: 'a', target: 'x', strength: 1, via: 'citation' as const };
    expect(scoreCandidates(new Map([['a', 1]]), [vote, vote])).toEqual(scoreCandidates(new Map([['a', 1]]), [vote]));
  });
});
