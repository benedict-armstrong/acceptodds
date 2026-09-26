import { and, asc, desc, eq, inArray, ne, sql, type SQL } from 'drizzle-orm';
import { getDb, type Database } from '@/db';
import { accounts, markets, orders, outcomes, type Market, type Outcome } from '@/db/schema';
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
