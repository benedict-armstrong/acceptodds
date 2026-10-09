import { and, eq, inArray, sql } from 'drizzle-orm';
import { HOUSE_HANDLE } from '@/server/engine';
import { walletFor } from '@/server/wallets';
import type { Database } from './index';
import { accounts, ledgerEntries, markets, wallets } from './schema';

/**
 * Deletes the markets the first trade would make (`server/market-start.ts`),
 * where nobody has traded yet, so those listings go back to having none:
 * a listing's main market, open or closed, with no orders, that is the
 * listing's only visible market. Standalone markets, drafts, settled
 * markets and listings with more than one market are left alone, as are
 * markets with comments unless `includeCommented` (their comments go too).
 *
 * The subsidy is undone, not orphaned: its two ledger rows are deleted, the
 * treasury's cached balance gets it back and the maker account is deleted,
 * so the sum of all balances is unchanged and `market:<slug>` is free for
 * the market the first trade makes. Any market whose ledger is not exactly
 * that balanced pair aborts the run.
 *
 * Batched, each batch one transaction holding its markets `FOR UPDATE`
 * (skipping one a trade holds) and then the treasury: markets before
 * accounts, the engine's lock order. Without `apply`, every batch rolls
 * back, so the report is exact and nothing changes.
 */
export async function dropUntradedMarkets(
  db: Database,
  opts: { apply: boolean; includeCommented?: boolean; batch?: number },
): Promise<{ markets: number; comments: number; refundedMicro: bigint; skippedCommented: number }> {
  const batch = opts.batch ?? 500;
  const total = { markets: 0, comments: 0, refundedMicro: 0n, skippedCommented: 0 };
  let after = '00000000-0000-0000-0000-000000000000';

  for (;;) {
    let last: string | null = null;
    try {
      await db.transaction(async (tx) => {
        const { rows } = await tx.execute<{ id: string; maker: string; comments: number }>(sql`
          select m.id, m.maker_account_id as maker,
                 (select count(*) from comments c where c.market_id = m.id)::int as comments
            from markets m
           where m.id > ${after}::uuid
             and m.listing_id is not null and m.is_main and m.status in ('open', 'closed')
             and m.order_count = 0
             and not exists (select 1 from orders o where o.market_id = m.id)
             and not exists (select 1 from markets s
                              where s.listing_id = m.listing_id and s.id <> m.id and s.status <> 'draft')
             ${opts.includeCommented ? sql`` : sql`and not exists (select 1 from comments c where c.market_id = m.id)`}
           order by m.id
           limit ${batch}
             for update of m skip locked
        `);
        if (rows.length === 0) return;
        last = rows[rows.length - 1].id;
        const ids = rows.map((r) => r.id);
        const makers = rows.map((r) => r.maker);

        const [house] = await tx.select().from(accounts).where(eq(accounts.handle, HOUSE_HANDLE)).for('update');
        const treasury = house ? await walletFor(tx, house.id, null, true) : null;
        if (!house || !treasury) throw new Error(`no house account "${HOUSE_HANDLE}"`);

        // The only ledger rows these markets and makers have: subsidy, treasury −s and maker +s, per market.
        const { rows: bad } = await tx.execute<{ market_id: string | null }>(sql`
          select e.market_id from ledger_entries e
           where (e.market_id in ${ids} or e.account_id in ${makers})
             and not (e.reason = 'subsidy' and e.market_id in ${ids}
                      and e.account_id in (${house.id}, (select maker_account_id from markets where id = e.market_id)))
           limit 1
        `);
        if (bad.length > 0) throw new Error(`market ${bad[0].market_id}: ledger has more than its subsidy; aborting`);
        const { rows: unbalanced } = await tx.execute<{ id: string }>(sql`
          select m.id from markets m join wallets w on w.account_id = m.maker_account_id
           where m.id in ${ids}
             and (w.balance_micro <> coalesce((select sum(delta_micro) from ledger_entries
                                                where wallet_id = w.id), 0)
                  or coalesce((select sum(delta_micro) from ledger_entries where market_id = m.id), 0) <> 0)
           limit 1
        `);
        if (unbalanced.length > 0) throw new Error(`market ${unbalanced[0].id}: subsidy is not balanced; aborting`);

        const removed = await tx
          .delete(ledgerEntries)
          .where(inArray(ledgerEntries.marketId, ids))
          .returning({ walletId: ledgerEntries.walletId, deltaMicro: ledgerEntries.deltaMicro });
        // The treasury's rows are its debits: minus them is what it gets back.
        const refund = -removed.filter((e) => e.walletId === treasury.id).reduce((a, e) => a + e.deltaMicro, 0n);
        await tx
          .update(wallets)
          .set({ balanceMicro: sql`${wallets.balanceMicro} + ${refund}` })
          .where(eq(wallets.id, treasury.id));
        await tx.delete(markets).where(inArray(markets.id, ids));
        await tx.delete(accounts).where(and(inArray(accounts.id, makers), eq(accounts.isHouse, true)));

        total.markets += ids.length;
        total.comments += rows.reduce((a, r) => a + r.comments, 0);
        total.refundedMicro += refund;
        if (!opts.apply) throw ROLLBACK;
      });
    } catch (err) {
      if (err !== ROLLBACK) throw err;
    }
    if (last === null) break;
    after = last;
  }

  if (!opts.includeCommented) {
    const { rows } = await db.execute<{ n: number }>(sql`
      select count(*)::int as n from markets m
       where m.listing_id is not null and m.is_main and m.status in ('open', 'closed') and m.order_count = 0
         and exists (select 1 from comments c where c.market_id = m.id)
    `);
    total.skippedCommented = rows[0]?.n ?? 0;
  }
  return total;
}

/** Thrown to roll a dry run's batch back. */
const ROLLBACK = new Error('dry run');
