import { cache } from 'react';
import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { getDb } from '@/db';
import type * as schema from '@/db/schema';
import { accounts, markets, outcomes, positions, wallets, type Account } from '@/db/schema';
import { accountHoldings } from './account-read';
import { startingBalanceMicro, walletFor } from './wallets';
import { costToTrade } from '@/lib/lmsr';
import { costToMicro, microToFloat } from '@/lib/money';

type Database = NodePgDatabase<typeof schema>;

/**
 * Liquidation value, for many accounts at once, **in one venue**: a wallet's
 * cash and the holdings on that venue's markets. **Reads only.**
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
  /** The venue: every figure below is the account's wallet there and its markets alone. */
  kind: string;
  /** `wallets.balance_micro`, or the starting grant while the account has no wallet in the venue. */
  cashMicro: bigint;
  /** Σ quoted exit over the account's open holdings in the venue. */
  holdingsValueMicro: bigint;
  /** `cash + holdings value`: liquidation value, not a mark. */
  netWorthMicro: bigint;
  /**
   * `holdings value + Σ trade ledger rows on markets not yet settled`: what
   * liquidating now would make, against what the holdings cost net of what
   * was already sold.
   */
  unrealizedPnlMicro: bigint;
  /**
   * `−Σ trade ledger rows on markets not yet settled`: what the open
   * holdings cost net of sales, the base unrealized P&L is a percentage of.
   * Zero or less when sales have already returned the stake.
   */
  openCostMicro: bigint;
  /** Σ `trade` + `settlement` ledger rows on settled markets. */
  realizedPnlMicro: bigint;
  /** Distinct settled markets the account traded in. */
  settledMarkets: number;
}

/** A holding's sell-everything proceeds, rounded as `engine.priceTrade` rounds (in the house's favour). */
export function quotedExitMicro(board: { q: number[]; b: number }, index: number, sharesMicro: bigint): bigint {
  return -costToMicro(costToTrade(board.q, index, microToFloat(-sharesMicro), board.b));
}

export interface TradeFlow {
  openTradeMicro: bigint;
  realizedMicro: bigint;
  settledMarkets: number;
}

/**
 * Per account and venue: Σ `trade` rows on markets not yet settled, and Σ
 * `trade` + `settlement` rows on settled markets with their count. `kind`
 * narrows it to one venue. `sum(bigint)` is `numeric`: read as text, never
 * as a JS number (§1.6).
 */
export async function tradeFlows(
  accountIds: string[],
  kind: string | null = null,
  database: Database = getDb(),
): Promise<Map<string, Map<string, TradeFlow>>> {
  const out = new Map<string, Map<string, TradeFlow>>();
  if (accountIds.length === 0) return out;
  const result = await database.execute<{
    account_id: string;
    kind: string;
    open_trade: string;
    realized: string;
    settled: number;
  }>(sql`
    select le.account_id, m.kind,
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
       ${kind === null ? sql`` : sql`and m.kind = ${kind}`}
     group by le.account_id, m.kind
  `);
  for (const r of result.rows) {
    const byKind = out.get(r.account_id) ?? new Map<string, TradeFlow>();
    byKind.set(r.kind, {
      openTradeMicro: BigInt(r.open_trade),
      realizedMicro: BigInt(r.realized),
      settledMarkets: r.settled,
    });
    out.set(r.account_id, byKind);
  }
  return out;
}

/**
 * Valuations in one venue for the given accounts, or for every non-house
 * account with a wallet there when `accountIds` is omitted. Accounts that do
 * not exist, or have no wallet in the venue, are left out: the venue's field
 * is the traders who have traded in it.
 */
export async function valuations(
  kind: string,
  accountIds?: string[],
  database: Database = getDb(),
): Promise<Map<string, Valuation & { account: Account }>> {
  if (accountIds && accountIds.length === 0) return new Map();
  const accountRows = await database
    .select({ account: accounts, cashMicro: wallets.balanceMicro })
    .from(accounts)
    .innerJoin(wallets, and(eq(wallets.accountId, accounts.id), eq(wallets.kind, kind)))
    .where(accountIds ? inArray(accounts.id, accountIds) : eq(accounts.isHouse, false));
  const ids = accountRows.map((a) => a.account.id);
  if (ids.length === 0) return new Map();

  // Open holdings in the venue. Settlement zeroes every position, so these
  // are all on markets that are open, closed or void.
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
    .where(
      and(
        inArray(positions.accountId, ids),
        ne(positions.sharesMicro, 0n),
        ne(markets.status, 'settled'),
        eq(markets.kind, kind),
      ),
    );

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
    const grouped = new Map<string, typeof outcomeRows>();
    for (const o of outcomeRows) {
      const group = grouped.get(o.marketId) ?? [];
      group.push(o);
      grouped.set(o.marketId, group);
    }
    for (const m of marketRows) {
      const rows = grouped.get(m.id) ?? [];
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

  const flows = await tradeFlows(ids, kind, database);
  const out = new Map<string, Valuation & { account: Account }>();
  for (const { account, cashMicro } of accountRows) {
    const value = holdingsValue.get(account.id) ?? 0n;
    const f = flows.get(account.id)?.get(kind);
    out.set(account.id, {
      account,
      accountId: account.id,
      kind,
      cashMicro,
      holdingsValueMicro: value,
      netWorthMicro: cashMicro + value,
      unrealizedPnlMicro: value + (f?.openTradeMicro ?? 0n),
      openCostMicro: -(f?.openTradeMicro ?? 0n),
      realizedPnlMicro: f?.realizedMicro ?? 0n,
      settledMarkets: f?.settledMarkets ?? 0,
    });
  }
  return out;
}

/**
 * One account's valuation in a venue, or `null` if the account does not
 * exist. With no wallet there yet it is what a first trade would open: the
 * starting grant, and nothing else.
 */
export function valuation(accountId: string, kind: string, database: Database = getDb()): Promise<Valuation | null> {
  return database === getDb() ? cachedValuation(accountId, kind, database) : readValuation(accountId, kind, database);
}

const cachedValuation = cache(readValuation);

async function readValuation(accountId: string, kind: string, database: Database): Promise<Valuation | null> {
  const snapshot = await accountHoldings(accountId, database);
  if (!snapshot) return null;
  let holdingsValueMicro = 0n;
  for (const row of snapshot.rows) {
    if (row.market.kind !== kind) continue;
    const board = snapshot.boards.get(row.market.id)!;
    const index = board.rows.findIndex((o) => o.id === row.outcome.id);
    holdingsValueMicro += quotedExitMicro({ q: board.q, b: row.market.b }, index, row.position.sharesMicro);
  }
  const [wallet, flows] = await Promise.all([
    walletFor(database, accountId, kind),
    accountTradeFlows(accountId, database),
  ]);
  const cashMicro = wallet?.balanceMicro ?? startingBalanceMicro();
  const flow = flows?.get(kind);
  return {
    accountId,
    kind,
    cashMicro,
    holdingsValueMicro,
    netWorthMicro: cashMicro + holdingsValueMicro,
    unrealizedPnlMicro: holdingsValueMicro + (flow?.openTradeMicro ?? 0n),
    openCostMicro: -(flow?.openTradeMicro ?? 0n),
    realizedPnlMicro: flow?.realizedMicro ?? 0n,
    settledMarkets: flow?.settledMarkets ?? 0,
  };
}

/** Request-scoped ledger aggregation shared by the navbar and portfolio: every venue, by kind. */
const cachedAccountFlows = cache(async (accountId: string, database: Database) =>
  (await tradeFlows([accountId], null, database)).get(accountId),
);
export async function accountTradeFlows(accountId: string, database: Database = getDb()) {
  return database === getDb()
    ? cachedAccountFlows(accountId, database)
    : (await tradeFlows([accountId], null, database)).get(accountId);
}
