import { and, asc, desc, eq, inArray, ne, sql, type SQL } from 'drizzle-orm';
import { getDb, type Database } from '@/db';
import { accounts, listingFollows, listings, markets, orders, outcomes, type Listing, type Market, type Outcome } from '@/db/schema';
import { headlinePrice, openingHeadline } from '@/lib/headline';
import { prices } from '@/lib/lmsr';
import { microToFloat } from '@/lib/money';
import { normalizeSearch, prefixTsquery } from '@/lib/search';
import { ApiError } from './api/errors';
import { valuations } from './valuation';

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
export async function resolveMarket(ref: string, database: Database = getDb()): Promise<Market> {
  const [row] = await database
    .select()
    .from(markets)
    .where(UUID.test(ref) ? eq(markets.id, ref.toLowerCase()) : eq(markets.slug, ref));
  if (!row) throw new ApiError(404, 'not_found', `no market ${ref}`);
  return row;
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

export async function marketView(market: Market, database: Database = getDb()): Promise<MarketView> {
  const [view] = await marketViews([market], database);
  return view;
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
    after
      ? sql`(${markets.createdAt}, ${markets.id}) < (${after.t}::timestamptz, ${after.id}::uuid)`
      : undefined,
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
        after
          ? sql`(${listings.createdAt}, ${listings.id}) < (${after.t}::timestamptz, ${after.id}::uuid)`
          : undefined,
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
  const shares = outcomeRows.map(() => 0n);

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
    for (const row of base) shares[ordinalOf.get(row.outcomeId)!] = BigInt(row.total);
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
        before
          ? sql`(${orders.createdAt}, ${orders.id}) < (${before.t}::timestamptz, ${before.id}::uuid)`
          : undefined,
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
  return ordersPage(eq(orders.marketId, market.id), q, database);
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

export interface LeaderboardRow {
  accountId: string;
  handle: string;
  displayName: string;
  isBot: boolean;
  institutionName: string | null;
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
 * Either way house accounts are excluded, and `rank` is SQL `rank()`: ties
 * share a rank.
 */
export async function leaderboard(
  q: { basis?: LeaderboardBasis; cursor?: string; limit: number },
  database: Database = getDb(),
): Promise<{ rows: LeaderboardRow[]; nextCursor: string | null }> {
  return (q.basis ?? 'settled_pnl') === 'net_worth'
    ? netWorthLeaderboard(q, database)
    : settledLeaderboard(q, database);
}

async function settledLeaderboard(
  q: { cursor?: string; limit: number },
  database: Database,
): Promise<{ rows: LeaderboardRow[]; nextCursor: string | null }> {
  const after = decodePnlCursor(q.cursor, 'settled_pnl');
  const result = await database.execute<{
    account_id: string;
    handle: string;
    display_name: string;
    is_bot: boolean;
    institution_name: string | null;
    pnl: string;
    markets: number;
    rank: number;
  }>(sql`
    select * from (
      select a.id as account_id, a.handle, a.display_name, a.is_bot, a.institution_name,
             s.pnl::text as pnl, s.pnl as pnl_num, s.markets,
             (rank() over (order by s.pnl desc))::int as rank
        from (${settledPnl}) s
        join accounts a on a.id = s.account_id and not a.is_house
    ) ranked
    ${after ? sql`where (ranked.pnl_num < ${after.p}::numeric or (ranked.pnl_num = ${after.p}::numeric and ranked.account_id > ${after.id}::uuid))` : sql``}
    order by ranked.pnl_num desc, ranked.account_id asc
    limit ${q.limit + 1}
  `);

  const page = result.rows.slice(0, q.limit);
  const values = await valuations(
    page.map((r) => r.account_id),
    database,
  );
  const rows: LeaderboardRow[] = page.map((r) => {
    const v = values.get(r.account_id);
    return {
      accountId: r.account_id,
      handle: r.handle,
      displayName: r.display_name,
      isBot: r.is_bot,
      institutionName: r.institution_name,
      settledPnlMicro: BigInt(r.pnl),
      settledMarkets: r.markets,
      netWorthMicro: v?.netWorthMicro ?? 0n,
      unrealizedPnlMicro: v?.unrealizedPnlMicro ?? 0n,
      rank: r.rank,
    };
  });
  const last = rows[rows.length - 1];
  return {
    rows,
    nextCursor:
      result.rows.length > q.limit && last
        ? encodeCursor({ p: last.settledPnlMicro.toString(), id: last.accountId })
        : null,
  };
}

/**
 * Valued and sorted in JS, then sliced at the cursor. Every page values the
 * whole field — one query per table (`valuations()`), not per holding — which
 * is fine for a field of hundreds to a few thousand traders and makes ranks
 * exact across pages. If the field outgrows that, snapshot the valuations.
 */
async function netWorthLeaderboard(
  q: { cursor?: string; limit: number },
  database: Database,
): Promise<{ rows: LeaderboardRow[]; nextCursor: string | null }> {
  const after = decodePnlCursor(q.cursor, 'net_worth');
  const all = [...(await valuations(undefined, database)).values()].sort((x, y) =>
    x.netWorthMicro !== y.netWorthMicro
      ? x.netWorthMicro > y.netWorthMicro
        ? -1
        : 1
      : x.accountId < y.accountId
        ? -1
        : x.accountId > y.accountId
          ? 1
          : 0,
  );

  const ranked: LeaderboardRow[] = [];
  all.forEach((v, i) => {
    const prev = ranked[i - 1];
    ranked.push({
      accountId: v.accountId,
      handle: v.account.handle,
      displayName: v.account.displayName,
      isBot: v.account.isBot,
      institutionName: v.account.institutionName,
      settledPnlMicro: v.realizedPnlMicro,
      settledMarkets: v.settledMarkets,
      netWorthMicro: v.netWorthMicro,
      unrealizedPnlMicro: v.unrealizedPnlMicro,
      rank: prev && prev.netWorthMicro === v.netWorthMicro ? prev.rank : i + 1,
    });
  });

  const start = after
    ? ranked.findIndex((r) => {
        const p = BigInt(after.p);
        return r.netWorthMicro < p || (r.netWorthMicro === p && r.accountId > after.id);
      })
    : 0;
  const rest = start < 0 ? [] : ranked.slice(start);
  const rows = rest.slice(0, q.limit);
  const last = rows[rows.length - 1];
  return {
    rows,
    nextCursor:
      rest.length > q.limit && last
        ? encodeCursor({ p: last.netWorthMicro.toString(), id: last.accountId, k: 'net_worth' })
        : null,
  };
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

export interface BrowseRow extends MarketView {
  /** The listing this row stands for, or null for a market that has none. */
  listing: Listing | null;
  /** Visible markets in the row: 1 for a standalone market. */
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
 * standalone market, or the listing's main market). Filtered by its `kind`
 * (the opaque grouping string, which the creating client sets to a venue like
 * "ICLR 2027") and status, and sorted by its closing date, its headline
 * (`markets.headline`, highest first), volume summed over the row, the latest
 * fill in the row, or its creation. Sorting reads only the engine's caches on
 * `markets`, never `orders`, so a venue of 30k papers costs a scan of 30k
 * index entries, not of every fill. Paged by offset: every sort but `newest`
 * moves with each fill, so a keyset cursor would be no steadier, and a page
 * number is what the list shows.
 *
 * With a non-blank `q`, only rows whose listing text or any visible market's
 * text in the row matches (see "free-text search"); the filters still apply,
 * and `relevance` orders by the best rank in the row. `relevance` without a
 * query falls back to `closing`.
 */
export async function browseListings(
  q: {
    kind?: string | null;
    status?: Market['status'] | 'all';
    sort: BrowseSort;
    q?: string | null;
    offset?: number;
    limit?: number;
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
  const text = normalizeSearch(q.q);
  const tq = text === null ? null : tsquery(text);
  const status = q.status ?? 'open';
  const limit = q.limit ?? 50;
  const offset = q.offset ?? 0;

  // A row's key: its listing, or the standalone market itself.
  const followed = (account: string) =>
    sql`exists (select 1 from listing_follows lf where lf.account_id = ${account} and lf.listing_id = m.listing_id)`;
  const held = (account: string) => sql`exists (
    select 1 from positions p
      join outcomes po on po.id = p.outcome_id
      join markets pm on pm.id = po.market_id
     where p.account_id = ${account} and p.shares_micro > 0
       and coalesce(pm.listing_id, pm.id) = coalesce(m.listing_id, m.id))`;
  const where = [
    sql`m.is_main`,
    status === 'all' ? undefined : sql`m.status = ${status}`,
    q.kind ? sql`m.kind = ${q.kind}` : undefined,
    q.followedBy ? followed(q.followedBy) : undefined,
    q.heldBy ? held(q.heldBy) : undefined,
    q.exceptFollowedBy ? sql`not ${followed(q.exceptFollowedBy)}` : undefined,
    q.exceptHeldBy ? sql`not ${held(q.exceptHeldBy)}` : undefined,
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
      ) hit on hit.k = coalesce(m.listing_id, m.id)`
    : sql``;

  // Over the \`rows\` CTE below, whose columns are the main market's and the
  // row's sums.
  const order = {
    closing: [sql`m.closes_at asc`],
    // Void has no headline, whatever the cache last held.
    likelihood: [sql`(case when m.status = 'void' then null else m.headline end) desc nulls last`, sql`m.closes_at asc`],
    volume: [sql`m.volume_micro + coalesce(sec.volume_micro, 0) desc`],
    activity: [sql`greatest(m.last_trade_at, sec.last_trade_at) desc nulls last`],
    newest: [sql`m.created_at desc`],
    relevance: tq ? [sql`hit.r desc`, sql`m.closes_at asc`] : [sql`m.closes_at asc`],
  }[q.sort];

  const from = sql`
      from markets m
      ${hits}
      -- Visible markets of a listing other than its main one, summed into the
      -- row. Few listings have any, and markets_secondary_idx holds just those.
      left join (
        select s.listing_id, sum(s.volume_micro) as volume_micro, sum(s.order_count) as order_count,
               max(s.last_trade_at) as last_trade_at, count(*) as markets
          from markets s
         where not s.is_main and s.status <> 'draft'
         group by s.listing_id
      ) sec on sec.listing_id = m.listing_id
     where ${sql.join(where, sql` and `)}`;
  const result = await database.execute<{
    id: string;
    volume: string;
    order_count: number;
    last_trade_at: string | null;
    markets: number;
    total: number;
  }>(sql`
    select m.id,
           (m.volume_micro + coalesce(sec.volume_micro, 0))::text as volume,
           (m.order_count + coalesce(sec.order_count, 0))::int as order_count,
           greatest(m.last_trade_at, sec.last_trade_at)::text as last_trade_at,
           (1 + coalesce(sec.markets, 0))::int as markets,
           (count(*) over ())::int as total
    ${from}
     order by ${sql.join([...order, sql`m.id desc`], sql`, `)}
     limit ${limit} offset ${offset}
  `);

  const found = result.rows;
  if (found.length === 0) {
    // Past the end, or nothing at all: the page is empty, the total is not.
    const total =
      offset === 0 ? 0 : ((await database.execute<{ n: number }>(sql`select count(*)::int as n ${from}`)).rows[0]?.n ?? 0);
    return { rows: [], total };
  }
  const total = found[0].total;

  const loaded = await database
    .select({ market: markets, listing: listings })
    .from(markets)
    .leftJoin(listings, eq(listings.id, markets.listingId))
    .where(inArray(
      markets.id,
      found.map((r) => r.id),
    ));
  const byId = new Map(loaded.map((r) => [r.market.id, r]));
  const inOrder = found.map((r) => byId.get(r.id)!);
  const views = await marketViews(
    inOrder.map((r) => r.market),
    database,
  );
  return {
    total,
    rows: views.map((v, i) => ({
      ...v,
      listing: inOrder[i].listing,
      marketCount: found[i].markets,
      // `sum(bigint)` is `numeric`: read as text, never as a JS number (§1.6).
      totalVolumeMicro: BigInt(found[i].volume),
      totalOrderCount: found[i].order_count,
      lastTradeAt: found[i].last_trade_at ? new Date(found[i].last_trade_at) : null,
    })),
  };
}

/** Every `kind` with at least one visible row, most rows first. A listing counts once, by its main market. */
export async function marketKinds(database: Database = getDb()): Promise<{ kind: string; count: number }[]> {
  return database
    .select({ kind: markets.kind, count: sql<number>`count(*)::int` })
    .from(markets)
    .where(eq(markets.isMain, true))
    .groupBy(markets.kind)
    // Byte order, so ties sort the same whatever locale the database was created with.
    .orderBy(sql`count(*) desc`, sql`${markets.kind} COLLATE "C"`);
}

/**
 * Each market's headline (`lib/headline.ts`) after each of its last `points`
 * fills, for list sparklines. Replayed from the fills: the share vector is the
 * running sum of order shares, and the headline of a market with more than two
 * outcomes depends on all of it, so `orders.price_after` (the traded outcome's
 * price only) is not enough. One query for the markets on a page (their whole
 * tapes); keep a per-fill headline if a single market's tape grows too long.
 */
export async function sparklines(
  views: MarketView[],
  points = 40,
  database: Database = getDb(),
): Promise<Map<string, number[]>> {
  const out = new Map<string, number[]>();
  const wanted = views.filter((v) => v.outcomes.length >= 2 && v.orderCount > 0);
  if (wanted.length === 0) return out;
  const result = await database.execute<{ market_id: string; ordinal: number; shares_micro: string }>(sql`
    select o.market_id, oc.ordinal, o.shares_micro::text as shares_micro
      from orders o join outcomes oc on oc.id = o.outcome_id
     where o.market_id in (${sql.join(
       wanted.map((v) => sql`${v.market.id}::uuid`),
       sql`, `,
     )})
     order by o.market_id, o.created_at, o.id
  `);
  const byMarket = new Map(wanted.map((v) => [v.market.id, v]));
  const shares = new Map(wanted.map((v) => [v.market.id, v.outcomes.map(() => 0n)]));
  for (const r of result.rows) {
    const v = byMarket.get(r.market_id)!;
    const q = shares.get(r.market_id)!;
    q[r.ordinal] += BigInt(r.shares_micro);
    const list = out.get(r.market_id) ?? [];
    list.push(headlinePrice(prices(q.map(microToFloat), v.market.b)));
    out.set(r.market_id, list);
  }
  for (const [id, list] of out) {
    // A market with fewer fills than asked for is shown from its opening price.
    if (list.length < points) list.unshift(openingHeadline(byMarket.get(id)!.outcomes.length));
    else out.set(id, list.slice(-points));
  }
  return out;
}

/** How many distinct accounts have traded in a market. A count, never who. */
export async function traderCount(marketId: string, database: Database = getDb()): Promise<number> {
  const [row] = await database
    .select({ n: sql<number>`count(distinct ${orders.accountId})::int` })
    .from(orders)
    .where(eq(orders.marketId, marketId));
  return row?.n ?? 0;
}
