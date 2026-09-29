import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { getDb } from '@/db';
import type * as schema from '@/db/schema';
import { accounts, markets, outcomes, positions, type Account } from '@/db/schema';
import { costToTrade } from '@/lib/lmsr';
import { costToMicro, microToFloat } from '@/lib/money';

type Database = NodePgDatabase<typeof schema>;

/**
 * Liquidation value, for many accounts at once. **Reads only.**
 *
 * An account's net worth here is `cash + Σ quoted exit`: what it would hold if
 * it sold every open holding right now, each holding priced as its own
 * sell-everything quote — exactly `getPortfolio().liquidationValueMicro`, and
 * exactly what `engine.quote()` would answer, because it is the same maths with
 * the same single rounding (`costToMicro` of `costToTrade`, as in
 * `engine.priceTrade`).
 *
 * Unlike mark-based net worth (invariant §1.2), this cannot be inflated by the
 * trader's own price impact: pushing a price up raises the mark, but selling
 * back walks the price down the same curve, so a buy followed by a quoted exit
 * returns at most what the buy cost (and, rounding in the house's favour,
 * never more). It is therefore safe to show and to rank on.
 *
 * The cost is one query per table, not one per holding.
 */

export interface Valuation {
  accountId: string;
  /** `accounts.balance_micro`. */
  cashMicro: bigint;
  /** Σ quoted exit over the account's open holdings. */
  holdingsValueMicro: bigint;
  /** `cash + holdings value`: liquidation value, not a mark. */
  netWorthMicro: bigint;
  /**
   * `holdings value + Σ trade ledger rows on markets not yet settled`: what
   * liquidating now would make, against what the holdings cost net of what
   * was already sold.
   */
  unrealizedPnlMicro: bigint;
  /** Σ `trade` + `settlement` ledger rows on settled markets. */
  realizedPnlMicro: bigint;
  /** Distinct settled markets the account traded in. */
  settledMarkets: number;
}

/** A holding's sell-everything proceeds, rounded as `engine.priceTrade` rounds (in the house's favour). */
export function quotedExitMicro(board: { q: number[]; b: number }, index: number, sharesMicro: bigint): bigint {
  return -costToMicro(costToTrade(board.q, index, microToFloat(-sharesMicro), board.b));
}

/**
 * Per account: Σ `trade` rows on markets not yet settled, and Σ `trade` +
 * `settlement` rows on settled markets with their count. `sum(bigint)` is
 * `numeric`: read as text, never as a JS number (§1.6).
 */
export async function tradeFlows(
  accountIds: string[],
  database: Database = getDb(),
): Promise<Map<string, { openTradeMicro: bigint; realizedMicro: bigint; settledMarkets: number }>> {
  const out = new Map<string, { openTradeMicro: bigint; realizedMicro: bigint; settledMarkets: number }>();
  if (accountIds.length === 0) return out;
  const result = await database.execute<{ account_id: string; open_trade: string; realized: string; settled: number }>(sql`
    select le.account_id,
           coalesce(sum(le.delta_micro) filter (where m.status <> 'settled' and le.reason = 'trade'), 0)::text as open_trade,
           coalesce(sum(le.delta_micro) filter (where m.status = 'settled'), 0)::text as realized,
           (count(distinct le.market_id) filter (where m.status = 'settled'))::int as settled
      from ledger_entries le
      join markets m on m.id = le.market_id
     where le.reason in ('trade', 'settlement')
       and le.account_id in (${sql.join(
         accountIds.map((id) => sql`${id}::uuid`),
         sql`, `,
       )})
     group by le.account_id
  `);
  for (const r of result.rows) {
    out.set(r.account_id, {
      openTradeMicro: BigInt(r.open_trade),
      realizedMicro: BigInt(r.realized),
      settledMarkets: r.settled,
    });
  }
  return out;
}

/**
 * Valuations for the given accounts, or for every non-house account when
 * `accountIds` is omitted. Accounts that do not exist are left out.
 */
export async function valuations(
  accountIds?: string[],
  database: Database = getDb(),
): Promise<Map<string, Valuation & { account: Account }>> {
  if (accountIds && accountIds.length === 0) return new Map();
  const accountRows = await database
    .select()
    .from(accounts)
    .where(accountIds ? inArray(accounts.id, accountIds) : eq(accounts.isHouse, false));
  const ids = accountRows.map((a) => a.id);
  if (ids.length === 0) return new Map();

  // Open holdings. Settlement zeroes every position, so these are all on
  // markets that are open, closed or void.
  const held = await database
    .select({
      accountId: positions.accountId,
      outcomeId: positions.outcomeId,
      sharesMicro: positions.sharesMicro,
      marketId: outcomes.marketId,
    })
    .from(positions)
    .innerJoin(outcomes, eq(outcomes.id, positions.outcomeId))
    .innerJoin(markets, eq(markets.id, outcomes.marketId))
    .where(and(inArray(positions.accountId, ids), ne(positions.sharesMicro, 0n), ne(markets.status, 'settled')));

  // The boards those holdings sit on, each read once.
  const marketIds = [...new Set(held.map((h) => h.marketId))];
  const boards = new Map<string, { q: number[]; b: number; index: Map<string, number> }>();
  if (marketIds.length > 0) {
    const [marketRows, outcomeRows] = await Promise.all([
      database.select({ id: markets.id, b: markets.b }).from(markets).where(inArray(markets.id, marketIds)),
      database
        .select()
        .from(outcomes)
        .where(inArray(outcomes.marketId, marketIds))
        .orderBy(asc(outcomes.marketId), asc(outcomes.ordinal)),
    ]);
    for (const m of marketRows) {
      const rows = outcomeRows.filter((o) => o.marketId === m.id);
      boards.set(m.id, {
        q: rows.map((o) => microToFloat(o.sharesMicro)),
        b: m.b,
        index: new Map(rows.map((o, i) => [o.id, i])),
      });
    }
  }

  const holdingsValue = new Map<string, bigint>();
  for (const h of held) {
    const board = boards.get(h.marketId)!;
    const exit = quotedExitMicro(board, board.index.get(h.outcomeId)!, h.sharesMicro);
    holdingsValue.set(h.accountId, (holdingsValue.get(h.accountId) ?? 0n) + exit);
  }

  const flows = await tradeFlows(ids, database);
  const out = new Map<string, Valuation & { account: Account }>();
  for (const account of accountRows) {
    const value = holdingsValue.get(account.id) ?? 0n;
    const f = flows.get(account.id);
    out.set(account.id, {
      account,
      accountId: account.id,
      cashMicro: account.balanceMicro,
      holdingsValueMicro: value,
      netWorthMicro: account.balanceMicro + value,
      unrealizedPnlMicro: value + (f?.openTradeMicro ?? 0n),
      realizedPnlMicro: f?.realizedMicro ?? 0n,
      settledMarkets: f?.settledMarkets ?? 0,
    });
  }
  return out;
}

/** One account's valuation, or `null` if it does not exist. */
export async function valuation(accountId: string, database: Database = getDb()): Promise<Valuation | null> {
  return (await valuations([accountId], database)).get(accountId) ?? null;
}
