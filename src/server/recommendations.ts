import { sql, type SQL } from 'drizzle-orm';
import { getDb, type Database } from '@/db';
import {
  NEAREST,
  relatedVotes,
  scoreCandidates,
  sourceWeights,
  topSources,
  vectorVotes,
  type Interaction,
  type InteractionKind,
  type Vote,
} from '@/lib/recommend';
import { mapCached } from './map-cache';
import { ReadCache } from './read-cache';

/**
 * The home list's `recommended` sort: what is near the papers the viewer
 * deliberately acted on, by the similarity service's related lists, the
 * map's vectors and citations (`lib/recommend.ts` scores it). Read-only and
 * computed per request; nothing is stored.
 *
 * Only the viewer's own acts are read: fills on any of a listing's markets,
 * comments, backings, follows, read markers, opening its market. Never page
 * views (`listing_views` is built so it cannot name anyone) and never
 * reading lists (a group's, not a person's). Nobody else's activity enters
 * the score, so it says nothing about what other traders did.
 *
 * Papers with no market are scored like any other: the related lists and
 * vectors cover every listing, so this is how an unopened paper is found.
 */

/** Interactions (any kind) before the sort is offered, unless the viewer has traded. */
export const MIN_INTERACTIONS = 2;

/**
 * A viewer's scores, kept a minute so paging through the list does not
 * rescan the vectors (~200 ms at 42k papers). A new interaction shows after
 * at most that.
 */
const scoreReads = new ReadCache(200);
const SCORES_TTL_MS = 60_000;

/** How long the vectors stay in memory; `setMap` drops them sooner (`map-cache.ts`). */
const VECTORS_TTL_MS = 3_600_000;

/** Every listed paper on the map with a vector, unit length, packed `dims` floats apiece. */
interface VectorIndex {
  ids: string[];
  row: Map<string, number>;
  dims: number;
  data: Float32Array;
}

function vectorIndex(database: Database): Promise<VectorIndex> {
  const compute = async (): Promise<VectorIndex> => {
    const result = await database.execute<{ id: string; vector: number[] }>(sql`
      select l.id, p.vector from map_points p join listings l on l.slug = p.slug where p.vector is not null
    `);
    const rows = result.rows.filter((r) => r.vector.length > 0);
    const dims = rows[0]?.vector.length ?? 0;
    const usable = rows.filter((r) => r.vector.length === dims);
    const data = new Float32Array(usable.length * dims);
    usable.forEach((r, i) => {
      let norm = 0;
      for (const x of r.vector) norm += x * x;
      const scale = norm > 0 ? 1 / Math.sqrt(norm) : 0;
      for (let k = 0; k < dims; k++) data[i * dims + k] = r.vector[k] * scale;
    });
    return { ids: usable.map((r) => r.id), row: new Map(usable.map((r, i) => [r.id, i])), dims, data };
  };
  return database === getDb() ? mapCached('recommend:vectors', VECTORS_TTL_MS, compute) : compute();
}

/** `source`'s nearest papers by cosine, nearest first, at most `NEAREST`, never itself. */
function nearest(index: VectorIndex, source: string): string[] {
  const i = index.row.get(source);
  if (i === undefined) return [];
  const { data, dims } = index;
  // The best so far, weakest first.
  const best: { j: number; s: number }[] = [];
  for (let j = 0; j < index.ids.length; j++) {
    if (j === i) continue;
    let s = 0;
    for (let k = 0; k < dims; k++) s += data[i * dims + k] * data[j * dims + k];
    if (best.length === NEAREST && s <= best[0].s) continue;
    if (best.length === NEAREST) best.shift();
    let at = 0;
    while (at < best.length && best[at].s < s) at++;
    best.splice(at, 0, { j, s });
  }
  return best.reverse().map((b) => index.ids[b.j]);
}

/** The viewer's own acts on listings: per listing and kind, the latest. */
async function interactions(accountId: string, database: Database): Promise<Interaction[]> {
  const result = await database.execute<{ listing_id: string; kind: InteractionKind; at: string }>(sql`
    select m.listing_id, 'trade' as kind, max(o.created_at)::text as at
      from orders o join markets m on m.id = o.market_id
     where o.account_id = ${accountId} and m.listing_id is not null
     group by 1
    union all
    select m.listing_id, 'comment', max(c.created_at)::text
      from comments c join markets m on m.id = c.market_id
     where c.account_id = ${accountId} and m.listing_id is not null
     group by 1
    union all
    select m.listing_id, 'backing', max(b.created_at)::text
      from comment_backings b join comments c on c.id = b.comment_id join markets m on m.id = c.market_id
     where b.account_id = ${accountId} and m.listing_id is not null
     group by 1
    union all
    select listing_id, 'follow', created_at::text from listing_follows where account_id = ${accountId}
    union all
    select listing_id, 'read', created_at::text from listing_reads where account_id = ${accountId}
    union all
    select listing_id, 'opened', created_at::text from markets
     where created_by = ${accountId} and listing_id is not null
  `);
  return result.rows.map((r) => ({ listingId: r.listing_id, kind: r.kind, at: new Date(r.at) }));
}

/** Every recommended paper's score for `accountId`; empty when they have acted on nothing. */
export function recommendationScores(
  accountId: string,
  database: Database = getDb(),
): Promise<ReadonlyMap<string, number>> {
  if (database !== getDb()) return computeScores(accountId, database);
  return scoreReads.get(accountId, SCORES_TTL_MS, () => computeScores(accountId, database));
}

async function computeScores(accountId: string, database: Database): Promise<Map<string, number>> {
  const weights = sourceWeights(await interactions(accountId, database));
  const sources = topSources(weights);
  if (sources.length === 0) return new Map();
  const ids = sql`${pgArray(sources)}::uuid[]`;

  const [related, cited, index] = await Promise.all([
    database.execute<{ source: string; target: string; score: number }>(sql`
      select r.listing_id as source, l.id as target, r.score
        from listing_related r join listings l on l.slug = r.related_slug
       where r.listing_id = any(${ids})
    `),
    // Both ways: what a source cites, and what cites a source.
    database.execute<{ source: string; target: string }>(sql`
      select r.listing_id as source, l.id as target
        from listing_references r join listings l on l.slug = r.cited_slug
       where r.listing_id = any(${ids})
      union
      select s.id, r.listing_id
        from listings s join listing_references r on r.cited_slug = s.slug
       where s.id = any(${ids})
    `),
    vectorIndex(database),
  ]);

  const votes: Vote[] = [
    ...relatedVotes(related.rows),
    ...cited.rows.map((r) => ({ ...r, strength: 1, via: 'citation' as const })),
    ...sources.flatMap((s) => vectorVotes(s, nearest(index, s))),
  ];
  // Only the top sources vote, but every acted-on paper is left out of the scores.
  const voting = new Set(sources);
  return scoreCandidates(new Map([...weights].map(([id, w]) => [id, voting.has(id) ? w : 0])), votes);
}

/**
 * One bound parameter holding a Postgres array literal: Drizzle would spread a
 * JS array into a list of parameters. Only for uuids and numbers, which need
 * no quoting.
 */
function pgArray(values: readonly (string | number)[]): string {
  return `{${values.join(',')}}`;
}

/** `(listing_id, score)` as a derived table to left join on `l.id`. */
export function scoresTable(scores: ReadonlyMap<string, number>): SQL {
  return sql`(select * from unnest(${pgArray([...scores.keys()])}::uuid[], ${pgArray([...scores.values()])}::float8[]) as r(listing_id, score))`;
}

/** Whether to offer the sort: the viewer has traded, or acted on papers `MIN_INTERACTIONS` times. */
export async function canRecommend(accountId: string, database: Database = getDb()): Promise<boolean> {
  const result = await database.execute<{ ok: boolean }>(sql`
    select exists (select 1 from orders where account_id = ${accountId})
        or (select count(*) from (
              select 1 from listing_follows where account_id = ${accountId}
              union all select 1 from listing_reads where account_id = ${accountId}
              union all (select 1 from comments where account_id = ${accountId} limit ${MIN_INTERACTIONS})
              union all (select 1 from comment_backings where account_id = ${accountId} limit ${MIN_INTERACTIONS})
              union all select 1 from markets where created_by = ${accountId} and listing_id is not null
            ) x) >= ${MIN_INTERACTIONS} as ok
  `);
  return result.rows[0]?.ok ?? false;
}
