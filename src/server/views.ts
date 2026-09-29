import { and, asc, desc, eq, inArray, ne, sql, type SQL } from 'drizzle-orm';
import { getDb, type Database } from '@/db';
import { accounts, listings, markets, orders, outcomes, type Listing, type Market, type Outcome } from '@/db/schema';
import { prices } from '@/lib/lmsr';
import { microToFloat } from '@/lib/money';
import { ApiError } from './api/errors';

/**
 * Read models for the public API. **Reads only** — nothing here writes, and
 * nothing here decides a price that anyone trades at; `engine.ts` does that.
 *
 * Pagination is keyset, never offset. A cursor is an opaque base64url blob
 * holding the sort key of the last row served. Timestamps in cursors are kept
 * as Postgres text at **microsecond** precision: a JS `Date` has only
 * milliseconds, and two fills in the same millisecond would otherwise make a
 * page boundary skip or repeat a row.
 */

// ---------------------------------------------------------------------------
// cursors
// ---------------------------------------------------------------------------

type CursorKey = { t: string; id: string } | { p: string; id: string };

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

function decodePnlCursor(cursor: string | undefined): { p: string; id: string } | null {
  if (cursor === undefined) return null;
  try {
    const key = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (typeof key?.p === 'string' && /^-?\d{1,20}$/.test(key.p) && typeof key?.id === 'string' && UUID.test(key.id)) {
      return { p: key.p, id: key.id };
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

  const stats = await database
    .select({
      marketId: orders.marketId,
      // `sum(bigint)` is `numeric`: read it as text, never as a JS number (§1.6).
      volume: sql<string>`coalesce(sum(abs(${orders.costMicro})), 0)::text`,
      count: sql<number>`count(*)::int`,
    })
    .from(orders)
    .where(inArray(orders.marketId, ids))
    .groupBy(orders.marketId);

  return rows.map((market) => {
    const mine = outcomeRows.filter((o) => o.marketId === market.id);
    const p = prices(
      mine.map((o) => microToFloat(o.sharesMicro)),
      market.b,
    );
    const s = stats.find((x) => x.marketId === market.id);
    return {
      market,
      outcomes: mine.map((o, i) => ({ ...o, price: p[i] })),
      volumeMicro: BigInt(s?.volume ?? '0'),
      orderCount: s?.count ?? 0,
    };
  });
}

export async function marketView(market: Market, database: Database = getDb()): Promise<MarketView> {
  const [view] = await marketViews([market], database);
  return view;
}

export async function listMarkets(
  q: { status?: Market['status']; kind?: string; cursor?: string; limit: number },
  database: Database = getDb(),
): Promise<{ views: MarketView[]; nextCursor: string | null }> {
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
  return rows.map((listing) => ({ listing, markets: views.filter((v) => v.market.listingId === listing.id) }));
}

export async function listingView(listing: Listing, database: Database = getDb()): Promise<ListingView> {
  const [view] = await listingViews([listing], database);
  return view;
}

export async function listListings(
  q: { kind?: string; cursor?: string; limit: number },
  database: Database = getDb(),
): Promise<{ views: ListingView[]; nextCursor: string | null }> {
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
// settled P&L — the only thing anyone is ranked on
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

export interface SettledRow {
  accountId: string;
  handle: string;
  displayName: string;
  isBot: boolean;
  institutionName: string | null;
  pnlMicro: bigint;
  markets: number;
  rank: number;
}

export async function leaderboard(
  q: { cursor?: string; limit: number },
  database: Database = getDb(),
): Promise<{ rows: SettledRow[]; nextCursor: string | null }> {
  const after = decodePnlCursor(q.cursor);
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

  const rows: SettledRow[] = result.rows.map((r) => ({
    accountId: r.account_id,
    handle: r.handle,
    displayName: r.display_name,
    isBot: r.is_bot,
    institutionName: r.institution_name,
    pnlMicro: BigInt(r.pnl),
    markets: r.markets,
    rank: r.rank,
  }));
  const page = rows.slice(0, q.limit);
  const last = page[page.length - 1];
  return {
    rows: page,
    nextCursor:
      rows.length > q.limit && last ? encodeCursor({ p: last.pnlMicro.toString(), id: last.accountId }) : null,
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

export const MARKET_SORTS = ['closing', 'volume', 'activity', 'newest'] as const;
export type MarketSort = (typeof MARKET_SORTS)[number];

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

/**
 * The market that stands for its row on the home page: a market with no
 * listing, or a listing's **main market** — its visible market with the lowest
 * `listing_rank` (ties by age). Filters and the closing sort read this market.
 */
const isRowMarket = sql`(
  ${markets.listingId} is null or ${markets.id} = (
    select m2.id from markets m2
     where m2.listing_id = ${markets.listingId} and m2.status <> 'draft'
     order by m2.listing_rank, m2.created_at, m2.id
     limit 1
  )
)`;

/** The markets a row covers: itself, or every market of its listing. */
const rowMarketIds = sql`(
  select m2.id from markets m2
   where m2.id = ${markets.id}
      or (${markets.listingId} is not null and m2.listing_id = ${markets.listingId} and m2.status <> 'draft')
)`;

/**
 * Rows for the home page: one per listing (a "paper"), plus one per market
 * that belongs to no listing. Filtered by `kind` (the opaque grouping string,
 * which the creating client sets to a venue like "ICLR 2027") and status, both
 * read from the row's main market, and sorted by the main market's closing
 * date, volume summed over the row, the latest fill in the row, or the main
 * market's creation. Not paginated: a venue has at most a few hundred rows,
 * and the page shows them all.
 */
export async function browseListings(
  q: { kind?: string | null; status?: Market['status'] | 'all'; sort: MarketSort; limit?: number },
  database: Database = getDb(),
): Promise<BrowseRow[]> {
  const volume = sql`(select coalesce(sum(abs(o.cost_micro)), 0) from orders o where o.market_id in ${rowMarketIds})`;
  const count = sql`(select count(*) from orders o where o.market_id in ${rowMarketIds})`;
  const lastTrade = sql`(select max(o.created_at) from orders o where o.market_id in ${rowMarketIds})`;
  const order = {
    closing: [sql`${markets.closesAt} asc`],
    volume: [sql`${volume} desc`],
    activity: [sql`${lastTrade} desc nulls last`],
    newest: [sql`${markets.createdAt} desc`],
  }[q.sort];

  const status = q.status ?? 'open';
  const rows = await database
    .select({
      market: markets,
      listing: listings,
      // `sum(bigint)` is `numeric`: read it as text, never as a JS number (§1.6).
      volume: sql<string>`${volume}::text`,
      count: sql<number>`${count}::int`,
      markets: sql<number>`(select count(*) from ${rowMarketIds} x)::int`,
      lastTradeAt: sql<string | null>`${lastTrade}::text`,
    })
    .from(markets)
    .leftJoin(listings, eq(listings.id, markets.listingId))
    .where(
      and(
        status === 'all' ? ne(markets.status, 'draft') : eq(markets.status, status),
        q.kind ? eq(markets.kind, q.kind) : undefined,
        isRowMarket,
      ),
    )
    .orderBy(...order, desc(markets.id))
    .limit(q.limit ?? 200);

  const views = await marketViews(
    rows.map((r) => r.market),
    database,
  );
  return views.map((v, i) => ({
    ...v,
    listing: rows[i].listing,
    marketCount: rows[i].markets,
    totalVolumeMicro: BigInt(rows[i].volume),
    totalOrderCount: rows[i].count,
    lastTradeAt: rows[i].lastTradeAt ? new Date(rows[i].lastTradeAt!) : null,
  }));
}

/** Every `kind` with at least one visible row, most rows first. A listing counts once, by its main market. */
export async function marketKinds(database: Database = getDb()): Promise<{ kind: string; count: number }[]> {
  return database
    .select({ kind: markets.kind, count: sql<number>`count(*)::int` })
    .from(markets)
    .where(and(ne(markets.status, 'draft'), isRowMarket))
    .groupBy(markets.kind)
    // Byte order, so ties sort the same whatever locale the database was created with.
    .orderBy(sql`count(*) desc`, sql`${markets.kind} COLLATE "C"`);
}

/**
 * The first outcome's price after each of a market's last `points` fills, for
 * list sparklines. Exact for binary markets without a replay, because the
 * other outcome's price is its complement; multi-outcome markets get none.
 */
export async function sparklines(
  views: MarketView[],
  points = 40,
  database: Database = getDb(),
): Promise<Map<string, number[]>> {
  const binary = views.filter((v) => v.outcomes.length === 2);
  if (binary.length === 0) return new Map();
  const result = await database.execute<{ market_id: string; ordinal: number; price_after: number }>(sql`
    select market_id, ordinal, price_after from (
      select o.market_id, oc.ordinal, o.price_after, o.created_at, o.id,
             row_number() over (partition by o.market_id order by o.created_at desc, o.id desc) as rn
        from orders o join outcomes oc on oc.id = o.outcome_id
       where o.market_id in (${sql.join(
         binary.map((v) => sql`${v.market.id}::uuid`),
         sql`, `,
       )})
    ) x where rn <= ${points}
    order by market_id, created_at, id
  `);
  const out = new Map<string, number[]>();
  for (const r of result.rows) {
    const p = r.ordinal === 0 ? r.price_after : 1 - r.price_after;
    const list = out.get(r.market_id) ?? [];
    list.push(p);
    out.set(r.market_id, list);
  }
  // A market with fewer fills than asked for is shown from its opening price,
  // which for two outcomes is always 1/2.
  for (const list of out.values()) if (list.length < points) list.unshift(0.5);
  return out;
}
