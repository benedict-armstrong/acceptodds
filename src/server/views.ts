import { cache } from 'react';
import { and, asc, desc, eq, inArray, ne, sql, type SQL } from 'drizzle-orm';
import { getDb, type Database } from '@/db';
import {
  accounts,
  groupMembers,
  listingFollows,
  listingReferences,
  listingRelated,
  listings,
  listingTexts,
  mapPoints,
  mapTopics,
  markets,
  orders,
  outcomes,
  positions,
  type Listing,
  type ListingReference,
  type Market,
  type Outcome,
} from '@/db/schema';
import { headlinePrice } from '@/lib/headline';
import { prices } from '@/lib/lmsr';
import { MINIMAP_CANDIDATES, MINIMAP_NEAREST } from '@/lib/map';
import { RELATED_UNBET } from '@/lib/related';
import { percentAhead } from '@/lib/leaderboard';
import { microToFloat } from '@/lib/money';
import { containsPattern, parseSearch, requiredText, websearchOf, type SearchNode } from '@/lib/query';
import { normalizeSearch, prefixTsquery } from '@/lib/search';
import { cosineDistance } from '@/lib/vectors';
import { ApiError } from './api/errors';
import { standingsGeneration, standingsChangesSince } from './standings-cache';
import { valuations } from './valuation';
import { marketReads, sparklineReads, MARKET_READ_TTL_MS } from './market-cache';

/**
 * Read models for the public API. **Reads only** — nothing here writes, and
 * nothing here decides a price that anyone trades at; `engine.ts` does that.
 *
 * API pagination is keyset, never offset (the home page's `browseListings`
 * is the one exception, and says why). A cursor is an opaque base64url blob
 * holding the sort key of the last row served. Timestamps in cursors are kept
 * as Postgres text at **microsecond** precision: a JS `Date` has only
 * milliseconds, and two fills in the same millisecond would otherwise make a
 * page boundary skip or repeat a row.
 */

// ---------------------------------------------------------------------------
// cursors
// ---------------------------------------------------------------------------

type CursorKey = { t: string; id: string } | { p: string; id: string; k?: 'net_worth' } | { r: string; id: string };

export function encodeCursor(key: CursorKey): string {
  return Buffer.from(JSON.stringify(key), 'utf8').toString('base64url');
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PG_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

function badCursor(): ApiError {
  return new ApiError(400, 'validation_error', 'invalid cursor');
}

function decodeTimeCursor(cursor: string | undefined): { t: string; id: string } | null {
  if (cursor === undefined) return null;
  try {
    const key = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (typeof key?.t === 'string' && PG_TS.test(key.t) && typeof key?.id === 'string' && UUID.test(key.id)) {
      return { t: key.t, id: key.id };
    }
  } catch {
    /* fall through */
  }
  throw badCursor();
}

/** A leaderboard cursor. Net-worth cursors carry `k`, so one basis's cursor is refused by the other. */
function decodePnlCursor(
  cursor: string | undefined,
  basis: 'settled_pnl' | 'net_worth',
): { p: string; id: string } | null {
  if (cursor === undefined) return null;
  try {
    const key = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    const kindOk = basis === 'net_worth' ? key?.k === 'net_worth' : key?.k === undefined;
    if (
      kindOk &&
      typeof key?.p === 'string' &&
      /^-?\d{1,20}$/.test(key.p) &&
      typeof key?.id === 'string' &&
      UUID.test(key.id)
    ) {
      return { p: key.p, id: key.id };
    }
  } catch {
    /* fall through */
  }
  throw badCursor();
}

/** A search-rank cursor: `r` is a `real` as Postgres prints it, which round-trips exactly. */
function decodeRankCursor(cursor: string | undefined): { r: string; id: string } | null {
  if (cursor === undefined) return null;
  try {
    const key = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (
      typeof key?.r === 'string' &&
      /^\d{1,20}(\.\d{1,20})?(e[+-]?\d{1,3})?$/.test(key.r) &&
      typeof key?.id === 'string' &&
      UUID.test(key.id)
    ) {
      return { r: key.r, id: key.id };
    }
  } catch {
    /* fall through */
  }
  throw badCursor();
}

/** A timestamptz column as UTC text with microseconds, for a cursor. */
function tsText(column: unknown): SQL<string> {
  return sql<string>`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

// ---------------------------------------------------------------------------
// free-text search
// ---------------------------------------------------------------------------

/**
 * Postgres full-text search over listings and markets.
 *
 * Each is its own weighted document — listing: title A, authors B, summary C;
 * market: question A, description C — built by the immutable SQL functions
 * `listing_search_vector` / `market_search_vector` (drizzle/0003) into stored
 * generated `search_vector` columns (drizzle/0006) with GIN indexes. The
 * columns are not in `schema.ts`, so no row read through Drizzle carries one;
 * refer to them only through `listingVector` / `marketVector`.
 *
 * The query is `websearch_to_tsquery('english', q)` — stemmed, with quotes,
 * `OR` and `-word` — OR-ed with a prefix query on the last word
 * (`lib/search.ts`) unless operators are used, so partial words match while
 * typing. Rank is `ts_rank_cd`. The query text is always a bound parameter.
 */
function tsquery(q: string): SQL {
  const prefix = prefixTsquery(q);
  return prefix
    ? sql`(websearch_to_tsquery('english', ${q}) || to_tsquery('english', ${prefix}))`
    : sql`websearch_to_tsquery('english', ${q})`;
}

/** `alias` is a table alias written in the query, never input. */
function listingVector(alias: string): SQL {
  return sql.raw(`"${alias}"."search_vector"`);
}

function marketVector(alias: string): SQL {
  return sql.raw(`"${alias}"."search_vector"`);
}

/** 0 for a document that does not match; `real`, never read into money. */
function rankOf(vector: SQL, tq: SQL): SQL {
  return sql`coalesce(ts_rank_cd(${vector}, ${tq}), 0)`;
}

/**
 * A home-page row's documents match `tq`: its listing's, its main market's
 * (`m`), or any other visible market's in the listing. Never null, so it
 * negates cleanly. Over `browseListings`' aliases: `l` the listing and `m`
 * its main market, either of which may be null (`ROWS`).
 */
function rowMatches(tq: SQL): SQL {
  return sql`(coalesce(${listingVector('l')} @@ ${tq}, false)
    or coalesce(${marketVector('m')} @@ ${tq}, false)
    or exists (select 1 from markets s2
                where s2.listing_id = l.id and not s2.is_main and s2.status <> 'draft'
                  and ${marketVector('s2')} @@ ${tq}))`;
}

const COMPARE_SQL = { '=': '=', '!=': '<>', '>': '>', '<': '<', '>=': '>=', '<=': '<=' } as const;

/**
 * A parsed search (`lib/query.ts`) as a predicate on a home-page row, over
 * `browseListings`' aliases: `m` the row's main market, `l` its listing,
 * `sec` its other visible markets' sums. Every value is a bound parameter;
 * operators come from the fixed map above. `skip` is the required text the
 * search join already enforces, left out here; `null` when nothing is left.
 */
function searchPredicate(node: SearchNode, skip: SearchNode | null): SQL | null {
  switch (node.kind) {
    case 'and':
    case 'or': {
      const parts = node.items.map((i) => searchPredicate(i, skip)).filter((p): p is SQL => p !== null);
      if (parts.length === 0) return null;
      return sql`(${sql.join(parts, node.kind === 'and' ? sql` and ` : sql` or `)})`;
    }
    case 'not': {
      const inner = searchPredicate(node.item, null);
      return inner === null ? null : sql`not ${inner}`;
    }
    case 'text':
      if (node === skip) return null;
      // Only exclusions: no document in the row may contain any of them.
      return node.include.length > 0
        ? rowMatches(tsquery(websearchOf(node)))
        : sql`not ${rowMatches(sql`websearch_to_tsquery('english', ${node.exclude.join(' or ')})`)}`;
    case 'match': {
      const column = {
        title: sql`coalesce(l.title, m.question)`,
        author: sql`coalesce(array_to_string(l.authors, ' '), '')`,
        // A newline between keywords, so a pattern never spans two of them.
        keyword: sql`coalesce(array_to_string(l.keywords, E'\\n'), '')`,
        area: sql`coalesce(l.primary_area, '')`,
        venue: ROW_KIND,
      }[node.field];
      return sql`${column} ${node.op === '=' ? sql`ilike` : sql`not ilike`} ${containsPattern(node.value)}`;
    }
    case 'status':
      return sql`${ROW_STATUS} ${sql.raw(COMPARE_SQL[node.op])} ${node.value}`;
    case 'compare': {
      const [column, value] = {
        // Void has no headline, whatever the cache last held: it compares as unknown.
        accept: [sql`(case when m.status = 'void' then null else m.headline end) * 100`, sql`${node.value}::float8`],
        // `sum(bigint)` is numeric; so is the bound: no float touches money (§1.6).
        volume: [ROW_VOLUME, sql`${node.value}::numeric * 1000000`],
        trades: [ROW_ORDERS, sql`${node.value}::bigint`],
      }[node.field];
      return sql`coalesce(${column} ${sql.raw(COMPARE_SQL[node.op])} ${value}, false)`;
    }
  }
}

/**
 * `listMarkets` with a query: a market matches on its own text or on its
 * listing's (so an author finds their paper's markets), and ranks by the
 * better of the two. Best first, ties by id, paged with a rank cursor.
 */
async function searchMarkets(
  text: string,
  q: { status?: Market['status']; kind?: string; cursor?: string; limit: number },
  database: Database,
): Promise<{ views: MarketView[]; nextCursor: string | null }> {
  const tq = tsquery(text);
  // Best rank per market, over its own text and its listing's, in one pass.
  const hits = sql`(
    select h.k, max(h.r) as r from (
      select ms.id as k, ${rankOf(marketVector('ms'), tq)} as r
        from markets ms where ${marketVector('ms')} @@ ${tq}
      union all
      select ml.id, ${rankOf(listingVector('ls'), tq)}
        from listings ls join markets ml on ml.listing_id = ls.id
       where ${listingVector('ls')} @@ ${tq}
    ) h group by h.k
  ) hit`;
  const rank = sql`hit.r`;
  const after = decodeRankCursor(q.cursor);
  const rows = await database
    .select({ market: markets, rank: sql<string>`(${rank})::text` })
    .from(markets)
    .innerJoin(hits, sql`hit.k = ${markets.id}`)
    .where(
      and(
        q.status ? eq(markets.status, q.status) : ne(markets.status, 'draft'),
        q.kind ? eq(markets.kind, q.kind) : undefined,
        after ? sql`(${rank}, ${markets.id}) < (${after.r}::real, ${after.id}::uuid)` : undefined,
      ),
    )
    .orderBy(sql`${rank} desc`, desc(markets.id))
    .limit(q.limit + 1);
  const page = rows.slice(0, q.limit);
  const last = page[page.length - 1];
  return {
    views: await marketViews(
      page.map((r) => r.market),
      database,
    ),
    nextCursor: rows.length > q.limit && last ? encodeCursor({ r: last.rank, id: last.market.id }) : null,
  };
}

/**
 * `listListings` with a query: a listing matches on its own text or on any of
 * its visible markets', and ranks by the best of them. Best first, ties by
 * id, paged with a rank cursor.
 */
async function searchListings(
  text: string,
  q: { kind?: string; cursor?: string; limit: number },
  database: Database,
): Promise<{ views: ListingView[]; nextCursor: string | null }> {
  const tq = tsquery(text);
  // Best rank per listing, over its own text and its visible markets', in one pass.
  const hits = sql`(
    select h.k, max(h.r) as r from (
      select ls.id as k, ${rankOf(listingVector('ls'), tq)} as r
        from listings ls where ${listingVector('ls')} @@ ${tq}
      union all
      select ms.listing_id, ${rankOf(marketVector('ms'), tq)}
        from markets ms
       where ms.listing_id is not null and ms.status <> 'draft' and ${marketVector('ms')} @@ ${tq}
    ) h group by h.k
  ) hit`;
  const rank = sql`hit.r`;
  const after = decodeRankCursor(q.cursor);
  const rows = await database
    .select({ listing: listings, rank: sql<string>`(${rank})::text` })
    .from(listings)
    .innerJoin(hits, sql`hit.k = ${listings.id}`)
    .where(
      and(
        q.kind ? eq(listings.kind, q.kind) : undefined,
        after ? sql`(${rank}, ${listings.id}) < (${after.r}::real, ${after.id}::uuid)` : undefined,
      ),
    )
    .orderBy(sql`${rank} desc`, desc(listings.id))
    .limit(q.limit + 1);
  const page = rows.slice(0, q.limit);
  const last = page[page.length - 1];
  return {
    views: await listingViews(
      page.map((r) => r.listing),
      database,
    ),
    nextCursor: rows.length > q.limit && last ? encodeCursor({ r: last.rank, id: last.listing.id }) : null,
  };
}

// ---------------------------------------------------------------------------
// markets
// ---------------------------------------------------------------------------

/** A market by uuid or by slug, or a 404. */
export function resolveMarket(ref: string, database: Database = getDb()): Promise<Market> {
  const compute = async () => {
    const [row] = await database
      .select()
      .from(markets)
      .where(UUID.test(ref) ? eq(markets.id, ref.toLowerCase()) : eq(markets.slug, ref));
    if (!row) throw new ApiError(404, 'not_found', `no market ${ref}`);
    return row;
  };
  return database === getDb() ? marketReads.get(`ref:${ref}`, MARKET_READ_TTL_MS, compute, ['refs']) : compute();
}

export interface MarketView {
  market: Market;
  outcomes: (Outcome & { price: number })[];
  volumeMicro: bigint;
  orderCount: number;
}

export async function marketViews(rows: Market[], database: Database = getDb()): Promise<MarketView[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((m) => m.id);

  const outcomeRows = await database
    .select()
    .from(outcomes)
    .where(inArray(outcomes.marketId, ids))
    .orderBy(asc(outcomes.marketId), asc(outcomes.ordinal));
  const byMarket = new Map<string, Outcome[]>();
  for (const o of outcomeRows) {
    const list = byMarket.get(o.marketId);
    if (list) list.push(o);
    else byMarket.set(o.marketId, [o]);
  }

  return rows.map((market) => {
    const mine = byMarket.get(market.id) ?? [];
    const p = prices(
      mine.map((o) => microToFloat(o.sharesMicro)),
      market.b,
    );
    return {
      market,
      outcomes: mine.map((o, i) => ({ ...o, price: p[i] })),
      // The engine's caches of the fills (`markets.volume_micro`, `order_count`).
      volumeMicro: market.volumeMicro,
      orderCount: market.orderCount,
    };
  });
}

export function marketView(market: Market, database: Database = getDb()): Promise<MarketView> {
  const compute = async () => (await marketViews([market], database))[0];
  return database === getDb()
    ? marketReads.get(`board:${market.id}:${market.orderCount}:${market.status}`, MARKET_READ_TTL_MS, compute, [
        market.id,
      ])
    : compute();
}

/** Markets, newest first; or, with a non-blank `q`, by search rank (`searchMarkets`). */
export async function listMarkets(
  q: { status?: Market['status']; kind?: string; q?: string; cursor?: string; limit: number },
  database: Database = getDb(),
): Promise<{ views: MarketView[]; nextCursor: string | null }> {
  const text = normalizeSearch(q.q);
  if (text !== null) return searchMarkets(text, q, database);
  const after = decodeTimeCursor(q.cursor);
  const where = [
    q.status ? eq(markets.status, q.status) : ne(markets.status, 'draft'),
    q.kind ? eq(markets.kind, q.kind) : undefined,
    after ? sql`(${markets.createdAt}, ${markets.id}) < (${after.t}::timestamptz, ${after.id}::uuid)` : undefined,
  ];

  const rows = await database
    .select({ market: markets, ts: tsText(markets.createdAt) })
    .from(markets)
    .where(and(...where))
    .orderBy(desc(markets.createdAt), desc(markets.id))
    .limit(q.limit + 1);

  const page = rows.slice(0, q.limit);
  const last = page[page.length - 1];
  return {
    views: await marketViews(
      page.map((r) => r.market),
      database,
    ),
    nextCursor: rows.length > q.limit && last ? encodeCursor({ t: last.ts, id: last.market.id }) : null,
  };
}

// ---------------------------------------------------------------------------
// listings — opaque subjects that group markets (the UI calls one a "paper")
// ---------------------------------------------------------------------------

/** A listing by uuid or by slug, or a 404. */
export async function resolveListing(ref: string, database: Database = getDb()): Promise<Listing> {
  const [row] = await database
    .select()
    .from(listings)
    .where(UUID.test(ref) ? eq(listings.id, ref.toLowerCase()) : eq(listings.slug, ref));
  if (!row) throw new ApiError(404, 'not_found', `no listing ${ref}`);
  return row;
}

export interface ListingView {
  listing: Listing;
  /** Visible (non-draft) markets, main market (lowest rank) first. */
  markets: MarketView[];
  /** How many accounts follow it. Never who. */
  followers: number;
}

export async function listingViews(rows: Listing[], database: Database = getDb()): Promise<ListingView[]> {
  if (rows.length === 0) return [];
  const marketRows = await database
    .select()
    .from(markets)
    .where(
      and(
        inArray(
          markets.listingId,
          rows.map((l) => l.id),
        ),
        ne(markets.status, 'draft'),
      ),
    )
    .orderBy(asc(markets.listingRank), asc(markets.createdAt), asc(markets.id));
  const views = await marketViews(marketRows, database);
  const follows = await database
    .select({ listingId: listingFollows.listingId, n: sql<number>`count(*)::int` })
    .from(listingFollows)
    .where(
      inArray(
        listingFollows.listingId,
        rows.map((l) => l.id),
      ),
    )
    .groupBy(listingFollows.listingId);
  return rows.map((listing) => ({
    listing,
    markets: views.filter((v) => v.market.listingId === listing.id),
    followers: follows.find((f) => f.listingId === listing.id)?.n ?? 0,
  }));
}

export async function listingView(listing: Listing, database: Database = getDb()): Promise<ListingView> {
  const [view] = await listingViews([listing], database);
  return view;
}

// ---------------------------------------------------------------------------
// citations (#38) — a listing's bibliography, and the listings that cite it
// ---------------------------------------------------------------------------

/** A listing that is cited or citing, with its main market (`null` when it has no visible one). */
export interface CitedListing {
  listing: Listing;
  main: MarketView | null;
}

export interface ListingCitations {
  /** The bibliography in its own order; `cited` when the slug names a listing here. */
  references: { reference: ListingReference; cited: CitedListing | null }[];
  /** Listings whose bibliography names this one, newest first, at most {@link CITED_BY_LIMIT}. */
  citedBy: CitedListing[];
  citedByTotal: number;
}

export const CITED_BY_LIMIT = 100;

/**
 * What a listing cites and what cites it. Matched by slug when read, never
 * stored resolved, so a reference to a listing added later links up by
 * itself. A listing citing itself is left out both ways.
 */
export async function listingCitations(listing: Listing, database: Database = getDb()): Promise<ListingCitations> {
  const refs = await database
    .select()
    .from(listingReferences)
    .where(eq(listingReferences.listingId, listing.id))
    .orderBy(asc(listingReferences.position));
  const slugs = [...new Set(refs.flatMap((r) => (r.citedSlug && r.citedSlug !== listing.slug ? [r.citedSlug] : [])))];
  const citedRows = slugs.length > 0 ? await database.select().from(listings).where(inArray(listings.slug, slugs)) : [];

  const citing = database
    .selectDistinct({ id: listingReferences.listingId })
    .from(listingReferences)
    .where(and(eq(listingReferences.citedSlug, listing.slug), ne(listingReferences.listingId, listing.id)))
    .as('citing');
  const citingRows = await database
    .select({ listing: listings, total: sql<number>`count(*) over ()::int` })
    .from(listings)
    .innerJoin(citing, eq(citing.id, listings.id))
    .orderBy(desc(listings.createdAt), desc(listings.id))
    .limit(CITED_BY_LIMIT);

  const views = await listingViews([...citedRows, ...citingRows.map((r) => r.listing)], database);
  const cited = (l: Listing): CitedListing => ({
    listing: l,
    main: views.find((v) => v.listing.id === l.id)?.markets[0] ?? null,
  });
  const bySlug = new Map(citedRows.map((l) => [l.slug, l]));
  return {
    references: refs.map((reference) => {
      const l =
        reference.citedSlug && reference.citedSlug !== listing.slug ? bySlug.get(reference.citedSlug) : undefined;
      return { reference, cited: l ? cited(l) : null };
    }),
    citedBy: citingRows.map((r) => cited(r.listing)),
    citedByTotal: citingRows[0]?.total ?? 0,
  };
}

/** A listing's related list as it is given out: `hidden` more were named but are held back. */
/** A listing's full text and its source as `../research` supplied them (`PUT /listings/{id}/text`), or null. */
export async function listingText(
  listingId: string,
  database: Database = getDb(),
): Promise<{ body: string; source: string | null } | null> {
  const [row] = await database
    .select({ body: listingTexts.body, source: listingTexts.source })
    .from(listingTexts)
    .where(eq(listingTexts.listingId, listingId));
  return row ?? null;
}

export interface RelatedList {
  related: CitedListing[];
  hidden: number;
}

/**
 * The listings the similarity service named as related to this one, in its
 * order, best first. Matched by slug when read; a slug with no listing here
 * (yet) is skipped, so the list is whatever can be shown.
 *
 * Until the listing has a bet (a fill on any of its markets) only the first
 * {@link RELATED_UNBET} are given out and the rest only counted, so a bet is
 * what shows them (`RelatedPapers`). `all` skips that, for the map's own
 * reads (the minimap), which may show them.
 */
export async function listingRelatedTo(
  listing: Listing,
  { all = false }: { all?: boolean } = {},
  database: Database = getDb(),
): Promise<RelatedList> {
  const [rows, [bet]] = await Promise.all([
    database
      .select({ listing: listings })
      .from(listingRelated)
      .innerJoin(listings, eq(listings.slug, listingRelated.relatedSlug))
      .where(eq(listingRelated.listingId, listing.id))
      .orderBy(asc(listingRelated.position)),
    all
      ? [{ id: listing.id }]
      : database
          .select({ id: markets.id })
          .from(markets)
          .where(and(eq(markets.listingId, listing.id), sql`${markets.orderCount} > 0`))
          .limit(1),
  ]);
  const given = bet ? rows : rows.slice(0, RELATED_UNBET);
  const views = await listingViews(
    given.map((r) => r.listing),
    database,
  );
  return {
    related: given.map(({ listing: l }) => ({
      listing: l,
      main: views.find((v) => v.listing.id === l.id)?.markets[0] ?? null,
    })),
    hidden: rows.length - given.length,
  };
}

export interface MapPointView {
  slug: string;
  title: string;
  primaryArea: string | null;
  x: number;
  y: number;
  region: number | null;
  cluster: number | null;
  /** The main market's headline cache (#12): a price, never a value; `null` when void, untraded or there is none. */
  headline: number | null;
}

/**
 * The whole map, by column: index `i` of each array is one paper, ordered by
 * slug. Columns, not one object per paper, and no titles (`mapTitles`):
 * with 40k papers that is 2 MB instead of 10, which the browser can draw
 * from before the titles arrive.
 */
export interface PaperMap {
  slugs: string[];
  x: number[];
  y: number[];
  region: (number | null)[];
  cluster: (number | null)[];
  /** Index into `areas` of each paper's primary area. */
  area: (number | null)[];
  /** The distinct primary areas, sorted. */
  areas: string[];
  /** The main market's headline cache (#12): a price, never a value; `null` when void or there is none. */
  headline: (number | null)[];
  regions: { number: number; label: string }[];
  clusters: { number: number; label: string }[];
}

/** Map points joined to their listing (an unlisted slug is skipped) and its main market's headline. */
function mapPointRows(database: Database) {
  return database
    .select({
      slug: listings.slug,
      title: listings.title,
      primaryArea: listings.primaryArea,
      x: mapPoints.x,
      y: mapPoints.y,
      region: mapPoints.region,
      cluster: mapPoints.cluster,
      headline: sql<
        number | null
      >`case when ${markets.status} = 'void' or ${markets.orderCount} = 0 then null else round(${markets.headline}::numeric, 4)::float8 end`,
    })
    .from(mapPoints)
    .innerJoin(listings, eq(listings.slug, mapPoints.slug))
    .leftJoin(markets, and(eq(markets.listingId, listings.id), eq(markets.isMain, true)))
    .$dynamic();
}

/**
 * The supplied paper map, each point joined to its listing by slug (a point
 * with no listing here is skipped) and to its main market's headline. One
 * pass over the whole map: it is drawn whole.
 */
export async function paperMap(database: Database = getDb()): Promise<PaperMap> {
  const [rows, topics] = await Promise.all([
    mapPointRows(database).orderBy(asc(mapPoints.slug)),
    database.select().from(mapTopics).orderBy(asc(mapTopics.level), asc(mapTopics.number)),
  ]);
  const topic = (level: string) =>
    topics.filter((t) => t.level === level).map(({ number, label }) => ({ number, label }));
  const areas = [...new Set(rows.flatMap((r) => (r.primaryArea === null ? [] : [r.primaryArea])))].sort();
  const areaIndex = new Map(areas.map((a, i) => [a, i]));
  return {
    slugs: rows.map((r) => r.slug),
    x: rows.map((r) => r.x),
    y: rows.map((r) => r.y),
    region: rows.map((r) => r.region),
    cluster: rows.map((r) => r.cluster),
    area: rows.map((r) => (r.primaryArea === null ? null : areaIndex.get(r.primaryArea)!)),
    areas,
    headline: rows.map((r) => r.headline),
    regions: topic('region'),
    clusters: topic('cluster'),
  };
}

/** The title of every paper on the map, by slug: what `paperMap` leaves out, for a second, later request. */
export async function mapTitles(database: Database = getDb()): Promise<Record<string, string>> {
  const rows = await database
    .select({ slug: listings.slug, title: listings.title })
    .from(mapPoints)
    .innerJoin(listings, eq(listings.slug, mapPoints.slug));
  return Object.fromEntries(rows.map((r) => [r.slug, r.title]));
}

export interface Minimap {
  /** The paper itself, its `MINIMAP_NEAREST` nearest papers and its related papers on the map. */
  points: MapPointView[];
  /**
   * The supplied vector of each point, in `points`' order: what the browser
   * lays the piece out again from. `null` unless every point has one.
   */
  vectors: number[][] | null;
  /** Index of the paper itself in `points`. */
  self: number;
  /** Indexes into `points` of its related papers, in the service's order. */
  related: number[];
  /** Related papers that are listed but not on the map. */
  relatedElsewhere: number;
  /** Every related pair between `points`, each listing's best `MAP_RELATED_DEPTH`, as indexes: tied close in a redraw. */
  edges: [number, number][];
  clusters: { number: number; label: string }[];
}

/**
 * The paper page's minimap: the paper among the papers nearest it and its
 * related papers wherever they lie on the supplied map, with their vectors
 * and the related pairs between them all, for the browser to lay out again
 * round the paper (`lib/map-layout.ts` `embedAround`). "Nearest" is by
 * vector when the paper has one: of its `MINIMAP_CANDIDATES` nearest on the
 * map, the `MINIMAP_NEAREST` with the smallest cosine distance, since the 2D
 * map has flattened what the vectors still hold. Positions, vectors and
 * relatedness are all other services'; nothing is computed from the papers
 * here. `null` when the paper is not on the map. `related` is
 * `listingRelatedTo(listing, { all: true })`.
 */
export async function listingMinimap(
  listing: Listing,
  related: CitedListing[],
  database: Database = getDb(),
): Promise<Minimap | null> {
  const [centre] = await database.select().from(mapPoints).where(eq(mapPoints.slug, listing.slug));
  if (!centre) return null;
  const relatedSlugs = related.map((r) => r.listing.slug);
  // The nearest first, by `map_points_xy_idx` (GiST, k-nearest): no pass over the whole map.
  const d2 = sql`point(${mapPoints.x}, ${mapPoints.y}) <-> point(${centre.x}, ${centre.y})`;
  const [candidates, clusters] = await Promise.all([
    database
      .select({ slug: mapPoints.slug, vector: mapPoints.vector })
      .from(mapPoints)
      .innerJoin(listings, eq(listings.slug, mapPoints.slug))
      .where(ne(mapPoints.slug, listing.slug))
      .orderBy(d2)
      .limit(centre.vector ? MINIMAP_CANDIDATES : MINIMAP_NEAREST),
    database
      .select({ number: mapTopics.number, label: mapTopics.label })
      .from(mapTopics)
      .where(eq(mapTopics.level, 'cluster'))
      .orderBy(asc(mapTopics.number)),
  ]);
  const nearest = centre.vector
    ? candidates
        .filter((c) => c.vector)
        .map((c) => ({ slug: c.slug, d: cosineDistance(centre.vector!, c.vector!) }))
        .sort((a, b) => a.d - b.d || (a.slug < b.slug ? -1 : 1))
        .slice(0, MINIMAP_NEAREST)
    : candidates;
  const wanted = [...new Set([listing.slug, ...nearest.map((r) => r.slug), ...relatedSlugs])];
  const [points, vectorRows, pairs] = await Promise.all([
    mapPointRows(database).where(inArray(mapPoints.slug, wanted)).orderBy(asc(mapPoints.slug)),
    database
      .select({ slug: mapPoints.slug, vector: mapPoints.vector })
      .from(mapPoints)
      .where(inArray(mapPoints.slug, wanted)),
    database
      .select({ from: listings.slug, to: listingRelated.relatedSlug })
      .from(listingRelated)
      .innerJoin(listings, eq(listings.id, listingRelated.listingId))
      .where(
        and(
          inArray(listings.slug, wanted),
          inArray(listingRelated.relatedSlug, wanted),
          sql`${listingRelated.position} < ${MAP_RELATED_DEPTH}`,
        ),
      ),
  ]);
  const vectorOf = new Map(vectorRows.map((r) => [r.slug, r.vector]));
  const vectors = points.every((p) => vectorOf.get(p.slug)) ? points.map((p) => vectorOf.get(p.slug)!) : null;
  const index = new Map(points.map((p, i) => [p.slug, i]));
  const on = relatedSlugs.flatMap((slug) => index.get(slug) ?? []);
  const here = new Set(points.map((p) => p.cluster));
  return {
    points,
    vectors,
    self: index.get(listing.slug)!,
    related: on,
    relatedElsewhere: related.length - on.length,
    // A slug that is wanted but not on the map has no index: skip its pairs.
    edges: pairs.flatMap(({ from, to }) => {
      const a = index.get(from);
      const b = index.get(to);
      return a === undefined || b === undefined || a === b ? [] : [[a, b] as [number, number]];
    }),
    clusters: clusters.filter((c) => here.has(c.number)),
  };
}

/** Whether the paper is on the supplied map: the paper page's cheap check before the browser asks for its minimap. */
export async function onMap(listing: Listing, database: Database = getDb()): Promise<boolean> {
  const [row] = await database.select({ slug: mapPoints.slug }).from(mapPoints).where(eq(mapPoints.slug, listing.slug));
  return row !== undefined;
}

/** How many of each listing's related entries the map draws on: the best few carry the structure. */
export const MAP_RELATED_DEPTH = 10;

/**
 * The related lists between papers on the map, for the browser to re-lay out
 * a subset (`components/map`). Only pairs where both ends are on the map and
 * listed, each listing's best `MAP_RELATED_DEPTH`, as slug pairs in the
 * supplier's order. The similarity is the service's; nothing is computed here.
 */
export async function mapRelated(database: Database = getDb()): Promise<{ from: string; to: string }[]> {
  const result = await database.execute<{ from: string; to: string }>(sql`
    select l.slug as "from", lr.related_slug as "to"
      from listing_related lr
      join listings l on l.id = lr.listing_id
      join map_points a on a.slug = l.slug
      join map_points b on b.slug = lr.related_slug
      join listings lb on lb.slug = lr.related_slug
     where lr.position < ${MAP_RELATED_DEPTH}
     order by l.slug, lr.position
  `);
  return result.rows;
}

/**
 * How many visitors read one listing and then another (`listing_transitions`),
 * by slug, most first. Only totals exist to be read.
 */
export async function listingTransitionCounts(
  min: number,
  database: Database = getDb(),
): Promise<{ from: string; to: string; count: number }[]> {
  const result = await database.execute<{ from: string; to: string; count: number }>(sql`
    select a.slug as "from", b.slug as "to", t.count
      from listing_transitions t
      join listings a on a.id = t.from_listing_id
      join listings b on b.id = t.to_listing_id
     where t.count >= ${min}
     order by t.count desc, a.slug, b.slug
  `);
  return result.rows.map((r) => ({ ...r, count: Number(r.count) }));
}

/** Listings, newest first; or, with a non-blank `q`, by search rank (`searchListings`). */
export async function listListings(
  q: { kind?: string; q?: string; cursor?: string; limit: number },
  database: Database = getDb(),
): Promise<{ views: ListingView[]; nextCursor: string | null }> {
  const text = normalizeSearch(q.q);
  if (text !== null) return searchListings(text, q, database);
  const after = decodeTimeCursor(q.cursor);
  const rows = await database
    .select({ listing: listings, ts: tsText(listings.createdAt) })
    .from(listings)
    .where(
      and(
        q.kind ? eq(listings.kind, q.kind) : undefined,
        after ? sql`(${listings.createdAt}, ${listings.id}) < (${after.t}::timestamptz, ${after.id}::uuid)` : undefined,
      ),
    )
    .orderBy(desc(listings.createdAt), desc(listings.id))
    .limit(q.limit + 1);
  const page = rows.slice(0, q.limit);
  const last = page[page.length - 1];
  return {
    views: await listingViews(
      page.map((r) => r.listing),
      database,
    ),
    nextCursor: rows.length > q.limit && last ? encodeCursor({ t: last.ts, id: last.listing.id }) : null,
  };
}

// ---------------------------------------------------------------------------
// price history — reconstructed from the fills, never sampled
// ---------------------------------------------------------------------------

export interface HistoryView {
  outcomes: Outcome[];
  points: { at: Date; prices: number[] }[];
  nextCursor: string | null;
}

/**
 * Every outcome's price after every fill, oldest first.
 *
 * `orders` stores only the traded outcome's price, so the full vector is
 * rebuilt by replaying share deltas from the start of the market. That is
 * exact — LMSR prices depend only on the share vector, and the share vector
 * is the sum of order shares (the concurrency test asserts it).
 */
export async function priceHistory(
  market: Market,
  q: { cursor?: string; limit: number },
  database: Database = getDb(),
): Promise<HistoryView> {
  const after = decodeTimeCursor(q.cursor);
  const outcomeRows = await database
    .select()
    .from(outcomes)
    .where(eq(outcomes.marketId, market.id))
    .orderBy(asc(outcomes.ordinal));
  const ordinalOf = new Map(outcomeRows.map((o) => [o.id, o.ordinal]));
  // The market's opening vector (zeros unless it opened at a prior), then the fills.
  const shares = outcomeRows.map((o) => o.openingSharesMicro);

  const points: HistoryView['points'] = [];
  if (after) {
    // The share vector as it stood at the cursor.
    const base = await database
      .select({ outcomeId: orders.outcomeId, total: sql<string>`sum(${orders.sharesMicro})::text` })
      .from(orders)
      .where(
        and(
          eq(orders.marketId, market.id),
          sql`(${orders.createdAt}, ${orders.id}) <= (${after.t}::timestamptz, ${after.id}::uuid)`,
        ),
      )
      .groupBy(orders.outcomeId);
    for (const row of base) shares[ordinalOf.get(row.outcomeId)!] += BigInt(row.total);
  } else {
    points.push({ at: market.createdAt, prices: prices(shares.map(microToFloat), market.b) });
  }

  const rows = await database
    .select({
      id: orders.id,
      outcomeId: orders.outcomeId,
      sharesMicro: orders.sharesMicro,
      createdAt: orders.createdAt,
      ts: tsText(orders.createdAt),
    })
    .from(orders)
    .where(
      and(
        eq(orders.marketId, market.id),
        after ? sql`(${orders.createdAt}, ${orders.id}) > (${after.t}::timestamptz, ${after.id}::uuid)` : undefined,
      ),
    )
    .orderBy(asc(orders.createdAt), asc(orders.id))
    .limit(q.limit + 1);

  const page = rows.slice(0, q.limit);
  for (const row of page) {
    shares[ordinalOf.get(row.outcomeId)!] += row.sharesMicro;
    points.push({ at: row.createdAt, prices: prices(shares.map(microToFloat), market.b) });
  }
  const last = page[page.length - 1];
  return {
    outcomes: outcomeRows,
    points,
    nextCursor: rows.length > q.limit && last ? encodeCursor({ t: last.ts, id: last.id }) : null,
  };
}

// ---------------------------------------------------------------------------
// the tape
// ---------------------------------------------------------------------------

const tapeColumns = {
  id: orders.id,
  marketId: orders.marketId,
  outcomeId: orders.outcomeId,
  sharesMicro: orders.sharesMicro,
  costMicro: orders.costMicro,
  priceBefore: orders.priceBefore,
  priceAfter: orders.priceAfter,
  idempotencyKey: orders.idempotencyKey,
  createdAt: orders.createdAt,
  ts: tsText(orders.createdAt),
};

export type OrderRow = {
  id: string;
  marketId: string;
  outcomeId: string;
  sharesMicro: bigint;
  costMicro: bigint;
  priceBefore: number;
  priceAfter: number;
  idempotencyKey: string | null;
  createdAt: Date;
};

async function ordersPage(
  filter: SQL,
  q: { cursor?: string; limit: number },
  database: Database,
): Promise<{ rows: OrderRow[]; nextCursor: string | null }> {
  const before = decodeTimeCursor(q.cursor);
  const rows = await database
    .select(tapeColumns)
    .from(orders)
    .where(
      and(
        filter,
        before ? sql`(${orders.createdAt}, ${orders.id}) < (${before.t}::timestamptz, ${before.id}::uuid)` : undefined,
      ),
    )
    .orderBy(desc(orders.createdAt), desc(orders.id))
    .limit(q.limit + 1);
  const page = rows.slice(0, q.limit);
  const last = page[page.length - 1];
  return {
    rows: page,
    nextCursor: rows.length > q.limit && last ? encodeCursor({ t: last.ts, id: last.id }) : null,
  };
}

/**
 * The public tape. The caller must not put `accountId` or `idempotencyKey` in
 * the response: the tape carries no identities (§12 Q4 is still open, and
 * anonymous is the default until it is answered).
 */
export function marketTape(market: Market, q: { cursor?: string; limit: number }, database: Database = getDb()) {
  const compute = () => ordersPage(eq(orders.marketId, market.id), q, database);
  return database === getDb()
    ? marketReads.get(`tape:${market.id}:${q.limit}:${q.cursor ?? ''}`, MARKET_READ_TTL_MS, compute, [market.id])
    : compute();
}

export function accountOrders(accountId: string, q: { cursor?: string; limit: number }, database: Database = getDb()) {
  return ordersPage(eq(orders.accountId, accountId), q, database);
}

// ---------------------------------------------------------------------------
// the leaderboard: settled P&L, or net worth at liquidation value
// ---------------------------------------------------------------------------

/**
 * Per-account P&L over **settled markets only**: the sum of the account's
 * `trade` and `settlement` ledger rows on markets whose status is `settled`.
 *
 * This is exact and it cannot be gamed by price impact, because at settlement
 * every position has been paid out at 1 or 0 and there is nothing left to
 * mark. Mid-market net worth is noise (invariant §1.2) and is never a basis
 * for ranking; an open market contributes nothing here.
 *
 * House accounts (the treasury and the per-market makers) are not traders and
 * are excluded.
 */
const settledPnl = sql`
  select le.account_id,
         sum(le.delta_micro) as pnl,
         count(distinct le.market_id)::int as markets
    from ledger_entries le
    join markets m on m.id = le.market_id and m.status = 'settled'
   where le.reason in ('trade', 'settlement')
   group by le.account_id
`;

export const LEADERBOARD_BASES = ['settled_pnl', 'net_worth'] as const;
export type LeaderboardBasis = (typeof LEADERBOARD_BASES)[number];

/** A trader as a people search finds them. */
export interface PersonRow {
  accountId: string;
  handle: string;
  displayName: string;
  isBot: boolean;
  /** `accounts.institutions`: confirmed affiliations, the sign-up address's first. */
  institutions: readonly string[];
}

/**
 * Traders whose handle or display name matches `text`, fuzzily: a
 * case-insensitive substring, or a word within `pg_trgm`'s word-similarity
 * threshold (so "hintn" finds "Hinton"). Substring matches first, then by
 * similarity, ties by handle. Both use the trigram GIN index on
 * `handle || ' ' || display_name` (drizzle/0007). House accounts are never
 * people. `text` is a bound parameter.
 */
export async function searchPeople(
  text: string,
  limit: number | null = 10,
  database: Database = getDb(),
): Promise<PersonRow[]> {
  const doc = sql`(a.handle || ' ' || a.display_name)`;
  const pattern = containsPattern(text);
  const result = await database.execute<{
    id: string;
    handle: string;
    display_name: string;
    is_bot: boolean;
    institutions: string[];
  }>(sql`
    select a.id, a.handle, a.display_name, a.is_bot, a.institutions
      from accounts a
     where not a.is_house and (${doc} ilike ${pattern} or ${text}::text <% ${doc})
     order by (${doc} ilike ${pattern}) desc, word_similarity(${text}::text, ${doc}) desc, a.handle
     ${limit === null ? sql`` : sql`limit ${limit}`}
  `);
  return result.rows.map((r) => ({
    accountId: r.id,
    handle: r.handle,
    displayName: r.display_name,
    isBot: r.is_bot,
    institutions: r.institutions,
  }));
}

export interface LeaderboardRow {
  accountId: string;
  handle: string;
  displayName: string;
  isBot: boolean;
  institutions: readonly string[];
  /** Σ `trade` + `settlement` rows on settled markets. */
  settledPnlMicro: bigint;
  settledMarkets: number;
  /** Liquidation value: cash + Σ quoted exit (`valuation.ts`), never a mark. */
  netWorthMicro: bigint;
  unrealizedPnlMicro: bigint;
  rank: number;
}

/**
 * The leaderboard, on one of two bases:
 *
 * - `settled_pnl`: P&L over settled markets only (above). Exact; an account
 *   with no settled market is not on it.
 * - `net_worth`: **liquidation value** — cash plus what selling every open
 *   holding now would actually pay (`valuation.ts`). Every non-house trader is
 *   on it. This is not the mark-based net worth of invariant §1.2, which a
 *   trader can inflate with their own price impact and which is still never
 *   ranked: a quoted exit walks the price back down the curve the trader
 *   pushed it up, so impact cannot be marked as profit.
 *
 * Either way house accounts are excluded, and ties share a rank (SQL
 * `rank()`: 1, 2, 2, 4).
 *
 * `institution` narrows the field to the traders with a confirmed
 * affiliation there (any of `accounts.institutions`) and ranks within it;
 * `group` to a group's members. `q` then keeps only the traders a people search finds
 * (`searchPeople`), each keeping their rank in the field; `fieldSize` is the
 * field before `q`, the denominator of a rank.
 */
export async function leaderboard(
  q: {
    basis?: LeaderboardBasis;
    institution?: string | null;
    group?: string | null;
    q?: string | null;
    cursor?: string;
    limit: number;
  },
  database: Database = getDb(),
): Promise<{ rows: LeaderboardRow[]; nextCursor: string | null; fieldSize: number }> {
  const basis = q.basis ?? 'settled_pnl';
  const after = decodePnlCursor(q.cursor, basis);
  const field = await leaderboardStandings({ basis, institution: q.institution, group: q.group }, database);
  const shown = await matchingTraders(field, q.q, database);

  const start = after
    ? shown.findIndex((r) => {
        const p = BigInt(after.p);
        const s = leaderboardScore(r, basis);
        return s < p || (s === p && r.accountId > after.id);
      })
    : 0;
  const rest = start < 0 ? [] : shown.slice(start);
  const rows = rest.slice(0, q.limit);
  const last = rows[rows.length - 1];
  return {
    rows,
    fieldSize: field.length,
    nextCursor:
      rest.length > q.limit && last
        ? encodeCursor({
            p: leaderboardScore(last, basis).toString(),
            id: last.accountId,
            ...(basis === 'net_worth' ? { k: 'net_worth' as const } : {}),
          })
        : null,
  };
}

/** What a basis ranks on. */
export function leaderboardScore(row: Omit<LeaderboardRow, 'rank'>, basis: LeaderboardBasis): bigint {
  return basis === 'net_worth' ? row.netWorthMicro : row.settledPnlMicro;
}

/** Where one trader stands in a ranked field (`leaderboardStandings`). */
export interface Standing {
  rank: number;
  fieldSize: number;
  /** `lib/leaderboard.percentAhead`: the share of the others scoring strictly lower; `null` alone on the board. */
  percentAhead: number | null;
}

/** `accountId`'s standing in `field`, or `null` when they are not on it. */
export function standingOf(
  field: readonly LeaderboardRow[],
  accountId: string,
  basis: LeaderboardBasis,
): Standing | null {
  const row = field.find((r) => r.accountId === accountId);
  if (!row) return null;
  const score = leaderboardScore(row, basis);
  const below = field.filter((r) => leaderboardScore(r, basis) < score).length;
  return { rank: row.rank, fieldSize: field.length, percentAhead: percentAhead(below, field.length) };
}

/** `field` narrowed to the traders a people search for `q` finds, in rank order. Blank `q` is the whole field. */
export async function matchingTraders(
  field: readonly LeaderboardRow[],
  q: string | null | undefined,
  database: Database = getDb(),
): Promise<readonly LeaderboardRow[]> {
  const text = normalizeSearch(q);
  if (text === null) return field;
  const found = new Set((await searchPeople(text, null, database)).map((p) => p.accountId));
  return field.filter((r) => found.has(r.accountId));
}

/**
 * The whole ranked field, best first, ties by account id. Valued and sorted
 * in JS — one query per table (`valuations()`), not per holding — which makes
 * ranks exact however the list is sliced (pages, the UI's window around the
 * viewer, a search). `institution` filters the field and ranks it again among
 * itself, as does `group`, a group's id (`server/groups.ts`).
 *
 * Cached per basis (`rankedField`), since the leaderboard, the portfolio and
 * the navbar all read it: the rows are frozen and shared, never mutate them.
 */
export async function leaderboardStandings(
  q: { basis?: LeaderboardBasis; institution?: string | null; group?: string | null },
  database: Database = getDb(),
): Promise<readonly LeaderboardRow[]> {
  const basis = q.basis ?? 'settled_pnl';
  const field = await rankedField(basis, database);
  const { institution, group } = q;
  if (institution == null && group == null) return field;
  const members =
    group == null
      ? null
      : new Set(
          (
            await database
              .select({ accountId: groupMembers.accountId })
              .from(groupMembers)
              .where(eq(groupMembers.groupId, group))
          ).map((m) => m.accountId),
        );
  return ranked(
    field.filter(
      (r) =>
        (institution == null || r.institutions.includes(institution)) && (members === null || members.has(r.accountId)),
    ),
    basis,
  );
}

/** How long a cached field may be served at most, for writers outside this process (`standings-cache.ts`). */
const STANDINGS_TTL_MS = 30_000;

const standingsCache = new Map<
  LeaderboardBasis,
  { generation: number; at: number; rows: Promise<readonly LeaderboardRow[]> }
>();

/**
 * The whole field for `basis`, from the cache when no write has committed
 * since it was computed (`standings-cache.ts`) and it is younger than the
 * TTL. Concurrent readers share one computation. Only reads on the shared
 * database are cached: a caller passing a transaction sees its own writes.
 */
function rankedField(basis: LeaderboardBasis, database: Database): Promise<readonly LeaderboardRow[]> {
  if (database !== getDb()) return computeField(basis, database);
  const generation = standingsGeneration();
  const hit = standingsCache.get(basis);
  if (hit && hit.generation === generation && Date.now() - hit.at < STANDINGS_TTL_MS) return hit.rows;
  const rows = computeField(basis, database);
  // Incremental fills must not extend the full valuation's expiry: otherwise
  // an external writer can remain invisible while local trades keep arriving.
  const entry = { generation, at: valuationCache?.fullAt ?? Date.now(), rows };
  standingsCache.set(basis, entry);
  // A failure is not cached: the next reader tries again.
  entry.rows.catch(() => {
    if (standingsCache.get(basis) === entry) standingsCache.delete(basis);
  });
  return entry.rows;
}

type FieldValues = Awaited<ReturnType<typeof valuations>>;
let valuationCache: { generation: number; fullAt: number; values: Promise<FieldValues> } | undefined;

/** Both ranking bases share the same valuations. Trades refresh holders of the changed markets only. */
function fieldValues(database: Database): Promise<FieldValues> {
  if (database !== getDb()) return valuations(undefined, database);
  const generation = standingsGeneration();
  const previous = valuationCache;
  const fresh = previous && Date.now() - previous.fullAt < STANDINGS_TTL_MS;
  if (fresh && previous.generation === generation) return previous.values;
  const changes = fresh ? standingsChangesSince(previous.generation) : null;
  const values =
    changes && previous ? updateFieldValues(previous.values, changes, database) : valuations(undefined, database);
  const entry = { generation, fullAt: changes && previous ? previous.fullAt : Date.now(), values };
  valuationCache = entry;
  values.catch(() => {
    if (valuationCache === entry) valuationCache = undefined;
  });
  return values;
}

async function updateFieldValues(
  previous: Promise<FieldValues>,
  changes: { marketId: string; accountId?: string }[],
  database: Database,
): Promise<FieldValues> {
  const values = new Map(await previous);
  const traded = [...new Set(changes.filter((c) => c.accountId).map((c) => c.marketId))];
  const settled = [...new Set(changes.filter((c) => !c.accountId).map((c) => c.marketId))];
  const affected = new Set(changes.flatMap((c) => (c.accountId ? [c.accountId] : [])));
  // A fill reprices every current holder, including holders of other outcomes.
  if (traded.length > 0) {
    const holders = await database
      .selectDistinct({ accountId: positions.accountId })
      .from(positions)
      .innerJoin(outcomes, eq(outcomes.id, positions.outcomeId))
      .where(and(inArray(outcomes.marketId, traded), ne(positions.sharesMicro, 0n)));
    for (const h of holders) affected.add(h.accountId);
  }
  // Settlement moves historical P&L to realized even for traders who already
  // sold out. Positions have been zeroed, so find every participant in orders.
  if (settled.length > 0) {
    const participants = await database
      .selectDistinct({ accountId: orders.accountId })
      .from(orders)
      .where(inArray(orders.marketId, settled));
    for (const p of participants) affected.add(p.accountId);
  }
  for (const [id, value] of await valuations([...affected], database)) {
    if (!value.account.isHouse) values.set(id, value);
  }
  return values;
}

async function computeField(basis: LeaderboardBasis, database: Database): Promise<readonly LeaderboardRow[]> {
  const values = await fieldValues(database);
  const rows = [...values.values()]
    .filter((v) => basis === 'net_worth' || v.settledMarkets > 0)
    .map((v) => ({
      accountId: v.accountId,
      handle: v.account.handle,
      displayName: v.account.displayName,
      isBot: v.account.isBot,
      institutions: v.account.institutions,
      settledPnlMicro: v.realizedPnlMicro,
      settledMarkets: v.settledMarkets,
      netWorthMicro: v.netWorthMicro,
      unrealizedPnlMicro: v.unrealizedPnlMicro,
    }));
  return ranked(rows, basis);
}

/** `rows` sorted best first, ties by account id, as new frozen rows with ranks; ties share a rank (1, 2, 2, 4). */
function ranked(rows: readonly Omit<LeaderboardRow, 'rank'>[], basis: LeaderboardBasis): readonly LeaderboardRow[] {
  const sorted = [...rows].sort((x, y) => {
    const a = leaderboardScore(x, basis);
    const b = leaderboardScore(y, basis);
    if (a !== b) return a > b ? -1 : 1;
    return x.accountId < y.accountId ? -1 : x.accountId > y.accountId ? 1 : 0;
  });
  const out: LeaderboardRow[] = [];
  sorted.forEach((r, i) => {
    const prev = out[i - 1];
    const rank = prev && leaderboardScore(prev, basis) === leaderboardScore(r, basis) ? prev.rank : i + 1;
    out.push(Object.freeze({ ...r, rank }));
  });
  return Object.freeze(out);
}

export async function publicAccount(handle: string, database: Database = getDb()) {
  const [account] = await database
    .select()
    .from(accounts)
    .where(and(eq(accounts.handle, handle), eq(accounts.isHouse, false)));
  if (!account) throw new ApiError(404, 'not_found', `no account ${handle}`);

  const result = await database.execute<{ pnl: string; markets: number }>(sql`
    select coalesce(sum(s.pnl), 0)::text as pnl, coalesce(sum(s.markets), 0)::int as markets
      from (${settledPnl}) s
     where s.account_id = ${account.id}
  `);
  const record = result.rows[0] ?? { pnl: '0', markets: 0 };
  return { account, settledPnlMicro: BigInt(record.pnl), settledMarkets: record.markets };
}

// ---------------------------------------------------------------------------
// browsing (the UI's home page)
// ---------------------------------------------------------------------------

export const MARKET_SORTS = ['closing', 'likelihood', 'volume', 'activity', 'newest'] as const;
export type MarketSort = (typeof MARKET_SORTS)[number];
/** Search rank: only meaningful with a query, and the UI's default when there is one. */
export type BrowseSort = MarketSort | 'relevance';

export interface BrowseRow {
  /** The listing this row stands for, or null for a market that has none. */
  listing: Listing | null;
  /**
   * The market that stands for the row (`markets.is_main`). Null for a
   * listing nobody has opened a market on (`server/market-start.ts`). With
   * no orders, the list shows no price for it either.
   */
  main: MarketView | null;
  /** Visible markets in the row: 1 for a standalone market, 0 before a listing's first trade. */
  marketCount: number;
  /** Volume and fills summed over every market in the row. */
  totalVolumeMicro: bigint;
  totalOrderCount: number;
  /** The latest fill in any market in the row. */
  lastTradeAt: Date | null;
}

/** Rows on one page of `browseListings`, and how many there are in all. */
export interface BrowsePage {
  rows: BrowseRow[];
  total: number;
}

/**
 * Rows for the home page: one per listing (a "paper"), plus one per market
 * that belongs to no listing, a page at a time.
 *
 * A row is read from the market that stands for it (`markets.is_main`: the
 * standalone market, or the listing's main market), if it has one. A listing
 * has none until its first trade makes it (`server/market-start.ts`); such a
 * row has no price, counts as `open` and is in its listing's `kind`. Every
 * sort puts traded rows first: a market nobody has traded yet (opened at
 * JEV's price) shows no price on the list either. Filtered by `kind` (the
 * opaque grouping string, which the creating client sets to a venue like
 * "ICLR 2027") and status, and sorted by its closing date, its headline
 * (`markets.headline`, highest first), volume summed over the row, the latest
 * fill in the row, or its creation. Sorting reads only the engine's caches on
 * `markets`, never `orders`. Paged by offset: every sort but `newest` moves
 * with each fill, so a keyset cursor would be no steadier, and a page number
 * is what the list shows.
 *
 * With a non-blank `q`, in the search syntax of `lib/query.ts`: words and
 * phrases match a row when its listing text or any visible market's text in
 * it does (see "free-text search"); filters compile to predicates on the row
 * (`searchPredicate`). The page's own filters still apply. `relevance`
 * orders by the best rank in the row of the text every match must contain
 * (`requiredText`), which is also what the GIN-indexed join matches on; with
 * none (only filters, or text only under `OR` or `-`) it falls back to
 * `closing`, as it does without a query.
 */
export async function browseListings(
  q: {
    kind?: string | null;
    status?: Market['status'] | 'all';
    sort: BrowseSort;
    q?: string | null;
    offset?: number;
    limit?: number;
    /** Only rows that have a market, i.e. leave out listings nobody has traded yet. */
    traded?: boolean;
    /** Only listings this account follows (so no unlisted markets). */
    followedBy?: string | null;
    /** Only rows where this account holds shares in any market of the row. */
    heldBy?: string | null;
    /** Leave out the listings this account follows. */
    exceptFollowedBy?: string | null;
    /** Leave out the rows this account holds shares in. */
    exceptHeldBy?: string | null;
  },
  database: Database = getDb(),
): Promise<BrowsePage> {
  const limit = q.limit ?? 50;
  const offset = q.offset ?? 0;
  const { from, order } = browseQuery(q);
  const result = await database.execute<{
    listing_id: string | null;
    market_id: string | null;
    volume: string;
    order_count: number;
    last_trade_at: string | null;
    markets: number;
    total: number;
  }>(sql`
    select l.id as listing_id, m.id as market_id,
           ${ROW_VOLUME}::text as volume,
           ${ROW_ORDERS}::int as order_count,
           greatest(m.last_trade_at, sec.last_trade_at)::text as last_trade_at,
           ((m.id is not null)::int + coalesce(sec.markets, 0))::int as markets,
           (count(*) over ())::int as total
    ${from}
     order by ${sql.join([...order, sql`coalesce(m.id, l.id) desc`], sql`, `)}
     limit ${limit} offset ${offset}
  `);

  const found = result.rows;
  if (found.length === 0) {
    // Past the end, or nothing at all: the page is empty, the total is not.
    const total =
      offset === 0
        ? 0
        : ((await database.execute<{ n: number }>(sql`select count(*)::int as n ${from}`)).rows[0]?.n ?? 0);
    return { rows: [], total };
  }
  const total = found[0].total;

  const marketIds = found.flatMap((r) => (r.market_id ? [r.market_id] : []));
  const listingIds = found.flatMap((r) => (r.listing_id ? [r.listing_id] : []));
  const [loadedMarkets, loadedListings] = await Promise.all([
    marketIds.length > 0 ? database.select().from(markets).where(inArray(markets.id, marketIds)) : [],
    listingIds.length > 0 ? database.select().from(listings).where(inArray(listings.id, listingIds)) : [],
  ]);
  const views = new Map((await marketViews(loadedMarkets, database)).map((v) => [v.market.id, v] as const));
  const listingById = new Map(loadedListings.map((l) => [l.id, l]));
  return {
    total,
    rows: found.map((r) => ({
      listing: r.listing_id ? listingById.get(r.listing_id)! : null,
      main: r.market_id ? views.get(r.market_id)! : null,
      marketCount: r.markets,
      // `sum(bigint)` is `numeric`: read as text, never as a JS number (§1.6).
      totalVolumeMicro: BigInt(r.volume),
      totalOrderCount: r.order_count,
      lastTradeAt: r.last_trade_at ? new Date(r.last_trade_at) : null,
    })),
  };
}

type BrowseFilter = Omit<Parameters<typeof browseListings>[0], 'offset' | 'limit'>;

/**
 * The home list's rows, one each: every listing (`l`) with its main market
 * (`m`, null before its first trade), and every visible market with no
 * listing (`m`, `l` null). Columns of either may be null; the expressions
 * below are what reads them.
 */
const ROWS = sql`
  (select ls.id as listing_id, mm.id as market_id
     from listings ls left join markets mm on mm.listing_id = ls.id and mm.is_main
   union all
   select null, ms.id from markets ms where ms.is_main and ms.listing_id is null) k
  left join listings l on l.id = k.listing_id
  left join markets m on m.id = k.market_id`;
/** A row's venue: its market's `kind`, else its listing's. */
const ROW_KIND = sql`coalesce(m.kind, l.kind)`;
/** A row's status: its market's; a listing without one yet is `open`, since a trade would make it. */
const ROW_STATUS = sql`coalesce(m.status, 'open')`;
/** Volume and fills over the row's markets; 0 before any. */
const ROW_VOLUME = sql`(coalesce(m.volume_micro, 0) + coalesce(sec.volume_micro, 0))`;
const ROW_ORDERS = sql`(coalesce(m.order_count, 0) + coalesce(sec.order_count, 0))`;

/**
 * The home list's rows as SQL: `from` (`ROWS`, the search hits `hit`, the
 * other markets' sums `sec`, through the `where`) and `order` for the sort.
 * Shared by `browseListings` and `mapSearch`, so the map's search is the
 * home page's.
 */
function browseQuery(q: BrowseFilter): { from: SQL; order: SQL[] } {
  const text = normalizeSearch(q.q);
  const node = text === null ? null : parseSearch(text).node;
  const required = requiredText(node);
  const tq = required === null ? null : tsquery(websearchOf(required));
  const predicate = node === null ? null : searchPredicate(node, required);
  const status = q.status ?? 'open';

  // A row's key: its listing, or the standalone market itself.
  const followed = (account: string) =>
    sql`exists (select 1 from listing_follows lf where lf.account_id = ${account} and lf.listing_id = l.id)`;
  const held = (account: string) => sql`exists (
    select 1 from positions p
      join outcomes po on po.id = p.outcome_id
      join markets pm on pm.id = po.market_id
     where p.account_id = ${account} and p.shares_micro > 0
       and coalesce(pm.listing_id, pm.id) = coalesce(l.id, m.id))`;
  const where = [
    status === 'all' ? undefined : sql`${ROW_STATUS} = ${status}`,
    q.kind ? sql`${ROW_KIND} = ${q.kind}` : undefined,
    q.traded ? sql`m.id is not null` : undefined,
    q.followedBy ? followed(q.followedBy) : undefined,
    q.heldBy ? held(q.heldBy) : undefined,
    q.exceptFollowedBy ? sql`not ${followed(q.exceptFollowedBy)}` : undefined,
    q.exceptHeldBy ? sql`not ${held(q.exceptHeldBy)}` : undefined,
    predicate ?? undefined,
  ].filter((w): w is SQL => w !== undefined);

  // Search: the best rank per row, over the listing's own text and every
  // visible market's in it. Each document is matched through its GIN index
  // and ranked on its stored vector.
  const hits = tq
    ? sql`join (
        select h.k, max(h.r) as r from (
          select coalesce(ms.listing_id, ms.id) as k, ${rankOf(marketVector('ms'), tq)} as r
            from markets ms where ms.status <> 'draft' and ${marketVector('ms')} @@ ${tq}
          union all
          select ls.id, ${rankOf(listingVector('ls'), tq)}
            from listings ls where ${listingVector('ls')} @@ ${tq}
        ) h group by h.k
      ) hit on hit.k = coalesce(l.id, m.id)`
    : sql``;

  // Traded rows first, whatever the sort: a listing with no market, or a
  // market nobody has traded (opened at JEV's price), shows no price yet.
  const order = [
    sql`(m.id is null or m.order_count = 0)`,
    ...{
      closing: [sql`m.closes_at asc`],
      // Void has no headline, whatever the cache last held.
      likelihood: [
        sql`(case when m.status = 'void' then null else m.headline end) desc nulls last`,
        sql`m.closes_at asc`,
      ],
      volume: [sql`${ROW_VOLUME} desc`],
      activity: [sql`greatest(m.last_trade_at, sec.last_trade_at) desc nulls last`],
      newest: [sql`m.created_at desc`],
      relevance: tq ? [sql`hit.r desc`, sql`m.closes_at asc`] : [sql`m.closes_at asc`],
    }[q.sort],
  ];

  const from = sql`
      from ${ROWS}
      ${hits}
      -- Visible markets of a listing other than its main one, summed into the
      -- row. Few listings have any, and markets_secondary_idx holds just those.
      left join (
        select s.listing_id, sum(s.volume_micro) as volume_micro, sum(s.order_count) as order_count,
               max(s.last_trade_at) as last_trade_at, count(*) as markets
          from markets s
         where not s.is_main and s.status <> 'draft'
         group by s.listing_id
      ) sec on sec.listing_id = l.id
     where ${where.length > 0 ? sql.join(where, sql` and `) : sql`true`}`;
  return { from, order };
}

/**
 * Every listing the home page's search (`lib/query.ts` syntax: words,
 * filters, `OR`, groups) finds, in relevance order, for the map to light up.
 * Every status unless the query says `status:`. Slugs only: the map already
 * holds the rest. `errors` are the terms the parser dropped.
 */
export async function mapSearch(
  q: string | null | undefined,
  database: Database = getDb(),
): Promise<{ slugs: string[]; errors: string[] }> {
  const text = normalizeSearch(q);
  if (text === null) return { slugs: [], errors: [] };
  // Nothing usable ("(", "author:", "-"): no terms, so no match — not every paper.
  const { node, errors } = parseSearch(text);
  if (node === null) return { slugs: [], errors };
  const { from, order } = browseQuery({ q: text, status: 'all', sort: 'relevance' });
  const result = await database.execute<{ slug: string }>(sql`
    select l.slug ${from} and l.slug is not null
     order by ${sql.join([...order, sql`l.id desc`], sql`, `)}
  `);
  return { slugs: result.rows.map((r) => r.slug), errors };
}

/** Every `kind` with at least one row, most rows first. A listing counts once, traded or not. */
export const marketKinds = cache(async (database: Database = getDb()): Promise<{ kind: string; count: number }[]> => {
  const result = await database.execute<{ kind: string; count: number }>(sql`
    select ${ROW_KIND} as kind, count(*)::int as count
      from ${ROWS}
     where ${ROW_KIND} is not null
     group by 1
     -- Byte order, so ties sort the same whatever locale the database was created with.
     order by 2 desc, ${ROW_KIND} COLLATE "C"
  `);
  return result.rows;
});

/**
 * The last `points` post-fill headlines, in tape order. One bounded query for
 * the page: the current share vector and recent fills come from the SAME SQL
 * snapshot. Walk backwards by subtracting fills, then reverse the prices.
 * The remainder is the opening vector when the tape is shorter than `points`,
 * so priors are preserved without reading the market's entire history.
 */
export async function sparklines(
  views: MarketView[],
  points = 40,
  database: Database = getDb(),
): Promise<Map<string, number[]>> {
  const wanted = views.filter((v) => v.outcomes.length >= 2 && v.orderCount > 0);
  if (wanted.length === 0 || points <= 0) return new Map();
  if (database !== getDb()) return recentSparklines(wanted, points, database);
  // A miss on any row starts one batch for the page; concurrent readers share
  // each market's promise. Entries are bounded and invalidated after fills.
  let batch: Promise<Map<string, number[]>> | undefined;
  const entries = await Promise.all(
    wanted.map(async (v) => {
      const line = await sparklineReads.get(
        `${v.market.id}:${v.orderCount}:${points}`,
        30_000,
        async () => {
          batch ??= recentSparklines(wanted, points, database);
          return (await batch).get(v.market.id) ?? [];
        },
        [v.market.id],
      );
      return [v.market.id, line] as const;
    }),
  );
  return new Map(entries);
}

async function recentSparklines(
  views: MarketView[],
  points: number,
  database: Database,
): Promise<Map<string, number[]>> {
  const result = await database.execute<{
    id: string;
    b: number;
    shares: string[];
    fills: { ordinal: number; shares: string }[];
  }>(sql`
    select m.id, m.b,
           array(select oc.shares_micro::text from outcomes oc where oc.market_id = m.id order by oc.ordinal) as shares,
           coalesce(t.fills, '[]'::jsonb) as fills
      from markets m
      left join lateral (
        select jsonb_agg(jsonb_build_object('ordinal', z.ordinal, 'shares', z.shares)
                         order by z.created_at desc, z.id desc) as fills
          from (
            select o.id, o.created_at, oc.ordinal, o.shares_micro::text as shares
              from orders o join outcomes oc on oc.id = o.outcome_id
             where o.market_id = m.id
             order by o.created_at desc, o.id desc
             limit ${points}
          ) z
      ) t on true
     where m.id in (${sql.join(
       views.map((v) => sql`${v.market.id}::uuid`),
       sql`, `,
     )})
  `);
  const out = new Map<string, number[]>();
  for (const row of result.rows) {
    const shares = row.shares.map(BigInt);
    const line: number[] = [];
    for (const fill of row.fills) {
      line.push(headlinePrice(prices(shares.map(microToFloat), row.b)));
      shares[fill.ordinal] -= BigInt(fill.shares);
    }
    if (line.length === 0) continue;
    if (line.length < points) line.push(headlinePrice(prices(shares.map(microToFloat), row.b)));
    out.set(row.id, line.reverse());
  }
  return out;
}

/** How many distinct accounts have traded in a market. A count, never who. */
/**
 * Of these markets, the ids of those still trading: status `open` and not yet
 * past `closes_at`, the engine's own test (`trade()` refuses the rest). For a
 * sell button that should not be offered on a market that would refuse it.
 */
export async function tradingMarketIds(ids: string[], database: Database = getDb()): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await database
    .select({ id: markets.id })
    .from(markets)
    .where(and(inArray(markets.id, ids), eq(markets.status, 'open'), sql`now() < ${markets.closesAt}`));
  return rows.map((r) => r.id);
}

/**
 * Whether `orderId` is the earliest order its account ever placed: the first
 * trade, which the UI follows with the first-trade page. Read from
 * `orders`, so a retry of that first order (same fill, replayed) still is.
 */
export async function isFirstOrder(accountId: string, orderId: string, database: Database = getDb()): Promise<boolean> {
  const [row] = await database
    .select({ id: orders.id })
    .from(orders)
    .where(eq(orders.accountId, accountId))
    .orderBy(asc(orders.createdAt), asc(orders.id))
    .limit(1);
  return row?.id === orderId;
}

/** Whether an account has ever placed an order: the home page hides its getting-started tutorial once it has. */
export async function hasTraded(accountId: string, database: Database = getDb()): Promise<boolean> {
  const [row] = await database.select({ id: orders.id }).from(orders).where(eq(orders.accountId, accountId)).limit(1);
  return row !== undefined;
}

/**
 * The earliest order an account ever placed, for the first-trade page: what
 * it staked, on which outcome of which market, and how it moved that
 * outcome's price. A first order is always a buy: there is nothing to sell
 * yet. `null` before any trade.
 *
 * The prices are replayed from the fills (the opening vector plus every
 * order before this one, in tape order), like `priceHistory`: `orders` keeps only
 * the price after, and what it was before depends on the whole vector.
 */
export async function firstFill(accountId: string, database: Database = getDb()) {
  const [row] = await database
    .select({
      id: orders.id,
      costMicro: orders.costMicro,
      sharesMicro: orders.sharesMicro,
      marketId: orders.marketId,
      outcomeId: orders.outcomeId,
      label: outcomes.label,
      kind: markets.kind,
      question: markets.question,
      b: markets.b,
      marketSlug: markets.slug,
      listingTitle: listings.title,
      listingSlug: listings.slug,
    })
    .from(orders)
    .innerJoin(markets, eq(markets.id, orders.marketId))
    .innerJoin(outcomes, eq(outcomes.id, orders.outcomeId))
    .leftJoin(listings, eq(listings.id, markets.listingId))
    .where(eq(orders.accountId, accountId))
    .orderBy(asc(orders.createdAt), asc(orders.id))
    .limit(1);
  if (!row) return null;

  const outcomeRows = await database
    .select({ id: outcomes.id, openingSharesMicro: outcomes.openingSharesMicro })
    .from(outcomes)
    .where(eq(outcomes.marketId, row.marketId))
    .orderBy(asc(outcomes.ordinal));
  // Compared in SQL, at the timestamps' own microseconds.
  const before = await database
    .select({ outcomeId: orders.outcomeId, total: sql<string>`sum(${orders.sharesMicro})::text` })
    .from(orders)
    .where(
      and(
        eq(orders.marketId, row.marketId),
        sql`(${orders.createdAt}, ${orders.id}) < (select o.created_at, o.id from orders o where o.id = ${row.id})`,
      ),
    )
    .groupBy(orders.outcomeId);
  const traded = new Map(before.map((r) => [r.outcomeId, BigInt(r.total)]));
  const shares = outcomeRows.map((o) => o.openingSharesMicro + (traded.get(o.id) ?? 0n));
  const i = outcomeRows.findIndex((o) => o.id === row.outcomeId);
  const priceBefore = prices(shares.map(microToFloat), row.b)[i];
  shares[i] += row.sharesMicro;
  const priceAfter = prices(shares.map(microToFloat), row.b)[i];

  return {
    costMicro: row.costMicro,
    marketId: row.marketId,
    label: row.label,
    kind: row.kind,
    question: row.question,
    marketSlug: row.marketSlug,
    listingTitle: row.listingTitle,
    listingSlug: row.listingSlug,
    priceBefore,
    priceAfter,
  };
}

export async function traderCount(marketId: string, database: Database = getDb()): Promise<number> {
  const [row] = await database
    .select({ n: sql<number>`count(distinct ${orders.accountId})::int` })
    .from(orders)
    .where(eq(orders.marketId, marketId));
  return row?.n ?? 0;
}

/** Every institution some trader is confirmed at, with how many: what the leaderboard's board picker finds. */
export async function traderInstitutions(database: Database = getDb()): Promise<{ name: string; traders: number }[]> {
  const result = await database.execute<{ name: string; traders: number }>(sql`
    select i.name, count(*)::int as traders
      from accounts a, unnest(a.institutions) as i(name)
     where not a.is_house
     group by i.name
     order by lower(i.name), i.name
  `);
  return result.rows;
}
