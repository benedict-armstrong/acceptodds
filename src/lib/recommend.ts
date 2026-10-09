/**
 * The `recommended` sort's scoring (`server/recommendations.ts` gathers its
 * inputs). Pure, so it is tested without a database.
 *
 * A viewer's **sources** are the papers they deliberately acted on, each
 * weighted by what they did (`WEIGHT`, summed over kinds) and by how far
 * back in their own history it was: the latest interaction counts fully,
 * each one before it `RECENCY` times as much. By order, not by date, so a
 * trader back after a month away has as sharp a profile as one active today.
 * Each source votes for papers near it, three ways:
 *
 * - its related list (the similarity service's), by score relative to the
 *   list's best: `RELATED`;
 * - its `NEAREST` nearest papers by the map's vectors, by rank: `VECTOR`;
 * - papers it cites or that cite it: `CITATION`.
 *
 * A candidate's score is the sum over sources of the source's weight times
 * its votes, so a paper near several of the viewer's papers rises. Then a
 * light diversity pass: candidates are grouped by the source that gave them
 * the most, and the k-th best of a group is multiplied by `DIVERSITY^k`, so
 * one paper's neighbours cannot fill the top of the list. Sources themselves
 * get no score.
 */

export type InteractionKind = 'trade' | 'comment' | 'backing' | 'follow' | 'read' | 'opened';

/** A trade costs reputation, so it counts most. */
export const WEIGHT: Readonly<Record<InteractionKind, number>> = {
  trade: 3,
  comment: 2,
  backing: 2,
  follow: 2,
  read: 1,
  opened: 1,
};
/** Each step back in the viewer's interactions, newest first. */
export const RECENCY = 0.9;
/** The sources that vote, heaviest first; the rest are only excluded from the list's top. */
export const MAX_SOURCES = 30;
/** Nearest papers by vector per source. */
export const NEAREST = 20;

export const RELATED = 1;
export const VECTOR = 0.6;
export const CITATION = 0.5;
export const DIVERSITY = 0.85;

export interface Interaction {
  listingId: string;
  kind: InteractionKind;
  at: Date;
}

/**
 * Each acted-on paper's weight: kinds summed, the k-th newest interaction
 * times `RECENCY^k`. Simultaneous ones are ordered by listing and kind, so
 * the result never depends on the input's order.
 */
export function sourceWeights(interactions: readonly Interaction[]): Map<string, number> {
  const newestFirst = [...interactions].sort(
    (a, b) =>
      b.at.getTime() - a.at.getTime() ||
      (a.listingId < b.listingId ? -1 : a.listingId > b.listingId ? 1 : 0) ||
      (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0),
  );
  const out = new Map<string, number>();
  newestFirst.forEach((i, k) => out.set(i.listingId, (out.get(i.listingId) ?? 0) + WEIGHT[i.kind] * RECENCY ** k));
  return out;
}

/** The heaviest `MAX_SOURCES` sources, ties by id so the choice is stable. */
export function topSources(weights: ReadonlyMap<string, number>): string[] {
  return [...weights]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, MAX_SOURCES)
    .map(([id]) => id);
}

/** One source's votes for one candidate, before the source's weight. */
export interface Vote {
  source: string;
  target: string;
  /** In [0, 1] after scaling by `vote`. */
  strength: number;
  via: 'related' | 'vector' | 'citation';
}

const VIA_WEIGHT = { related: RELATED, vector: VECTOR, citation: CITATION } as const;

/** Related-list votes: score over the list's best, so every source's list tops out at 1. */
export function relatedVotes(rows: readonly { source: string; target: string; score: number }[]): Vote[] {
  const best = new Map<string, number>();
  for (const r of rows) best.set(r.source, Math.max(best.get(r.source) ?? 0, r.score));
  return rows.map((r) => ({
    source: r.source,
    target: r.target,
    strength: (best.get(r.source) ?? 0) > 0 ? r.score / best.get(r.source)! : 0,
    via: 'related',
  }));
}

/** Vector votes from a source's neighbours, nearest first: 1 for the nearest, down to 1/NEAREST. */
export function vectorVotes(source: string, nearestFirst: readonly string[]): Vote[] {
  return nearestFirst.slice(0, NEAREST).map((target, k) => ({
    source,
    target,
    strength: 1 - k / NEAREST,
    via: 'vector',
  }));
}

/**
 * Each candidate's final score. Votes for a source, or from a paper that is
 * not a source, are ignored. A vote counted twice the same way (a duplicated
 * row) counts once.
 */
export function scoreCandidates(weights: ReadonlyMap<string, number>, votes: readonly Vote[]): Map<string, number> {
  const seen = new Set<string>();
  // candidate -> source -> contribution
  const by = new Map<string, Map<string, number>>();
  for (const v of votes) {
    const w = weights.get(v.source);
    if (w === undefined || weights.has(v.target) || v.strength <= 0) continue;
    const key = `${v.source}\u0000${v.target}\u0000${v.via}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const perSource = by.get(v.target) ?? new Map<string, number>();
    perSource.set(v.source, (perSource.get(v.source) ?? 0) + w * VIA_WEIGHT[v.via] * v.strength);
    by.set(v.target, perSource);
  }

  // Raw score, and the source that gave the most (ties by id).
  const raw: { target: string; score: number; top: string }[] = [];
  for (const [target, perSource] of by) {
    let score = 0;
    let top = '';
    let topValue = -1;
    for (const [source, value] of perSource) {
      score += value;
      if (value > topValue || (value === topValue && source < top)) [top, topValue] = [source, value];
    }
    raw.push({ target, score, top });
  }

  raw.sort((a, b) => b.score - a.score || (a.target < b.target ? -1 : 1));
  const rankInGroup = new Map<string, number>();
  const out = new Map<string, number>();
  for (const r of raw) {
    const k = rankInGroup.get(r.top) ?? 0;
    rankInGroup.set(r.top, k + 1);
    out.set(r.target, r.score * DIVERSITY ** k);
  }
  return out;
}
