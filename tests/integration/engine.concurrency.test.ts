import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { getDb } from '@/db';
import { accounts, ledgerEntries, markets, orders, outcomes, positions } from '@/db/schema';
import { costToTrade, prices } from '@/lib/lmsr';
import { costToMicro } from '@/lib/money';
import { reconcileBalances } from '@/server/accounts';
import { makerValueMicro, trade } from '@/server/engine';
import { EngineError } from '@/server/errors';
import { closePool, resetDatabase, seedMarket, type Fixture } from './helpers';

const db = getDb();

/**
 * The milestone 3 acceptance test: 50 concurrent trades at one market, and the
 * invariants hold afterwards.
 *
 * What it is really testing is the `SELECT ... FOR UPDATE` on the market row.
 * Without it, two traders read the same share vector, both get the pre-trade
 * price, and the difference is reputation created out of nothing — which shows
 * up here as a share vector that disagrees with the sum of the fills.
 */
const TRADERS = 10;
const TRADES = 50;

let fx: Fixture;
let outcome: Awaited<ReturnType<typeof settledResults>>;

async function settledResults() {
  const results = await Promise.allSettled(
    Array.from({ length: TRADES }, (_, i) => {
      const accountId = fx.traderIds[i % TRADERS];
      const outcomeId = fx.outcomeIds[i % 2];
      // 1..10 shares, so every trader can afford all five of their trades.
      const sharesMicro = BigInt(((i % 10) + 1) * 1_000_000);
      return trade(
        accountId,
        fx.marketId,
        outcomeId,
        sharesMicro,
        // A generous limit: this test is about the lock, not about slippage.
        10_000_000_000n,
        null,
        db,
      );
    }),
  );
  return results;
}

beforeAll(async () => {
  await resetDatabase();
  fx = await seedMarket(TRADERS);
  outcome = await settledResults();
}, 120_000);

afterAll(async () => {
  await closePool();
});

describe('50 concurrent trades against one market', () => {
  it('fills them all', () => {
    const rejected = outcome.filter((r) => r.status === 'rejected');
    for (const r of rejected) {
      // Surface the reason rather than swallowing it.
      console.error((r as PromiseRejectedResult).reason);
    }
    expect(rejected).toHaveLength(0);
    expect(outcome.filter((r) => r.status === 'fulfilled')).toHaveLength(TRADES);
  });

  it('serialized them: the tape replays exactly', async () => {
    /**
     * The direct evidence that the row lock did its job.
     *
     * Replaying the fills in the order they were written must reproduce, bit
     * for bit, the price and the cost each one recorded. Without `FOR UPDATE`
     * two concurrent trades read the same share vector, both record the same
     * `priceBefore`, and the replay diverges at the second one.
     */
    const [market] = await db.select().from(markets).where(eq(markets.id, fx.marketId));
    const board = await db
      .select()
      .from(outcomes)
      .where(eq(outcomes.marketId, fx.marketId))
      .orderBy(asc(outcomes.ordinal));
    const ordinalOf = new Map(board.map((o) => [o.id, o.ordinal]));

    const tape = await db
      .select()
      .from(orders)
      .where(eq(orders.marketId, fx.marketId))
      .orderBy(asc(orders.createdAt));
    expect(tape).toHaveLength(TRADES);

    const q = board.map(() => 0);
    for (const fill of tape) {
      const i = ordinalOf.get(fill.outcomeId)!;
      const delta = Number(fill.sharesMicro);

      expect(fill.priceBefore).toBe(prices(q, market.b)[i]);
      expect(fill.costMicro).toBe(costToMicro(costToTrade(q, i, delta, market.b)));
      q[i] += delta;
      expect(fill.priceAfter).toBe(prices(q, market.b)[i]);
    }

    // And the replayed vector is the vector on the board.
    board.forEach((o) => expect(o.sharesMicro).toBe(BigInt(q[o.ordinal])));
  });

  it('conserves reputation (§1.7)', async () => {
    const [{ total }] = await db
      .select({ total: sql<string>`coalesce(sum(${accounts.balanceMicro}), 0)` })
      .from(accounts);
    expect(BigInt(total)).toBe(fx.grantedMicro);

    // Trades move reputation; they never create it. Every non-issuance reason
    // nets to exactly zero.
    const [{ moved }] = await db
      .select({ moved: sql<string>`coalesce(sum(${ledgerEntries.deltaMicro}), 0)` })
      .from(ledgerEntries)
      .where(inArray(ledgerEntries.reason, ['trade', 'settlement', 'subsidy']));
    expect(BigInt(moved)).toBe(0n);
  });

  it('leaves no negative balances', async () => {
    const negative = await db
      .select({ id: accounts.id, handle: accounts.handle, balanceMicro: accounts.balanceMicro })
      .from(accounts)
      .where(sql`${accounts.balanceMicro} < 0`);
    expect(negative).toEqual([]);
  });

  it('keeps balance_micro equal to the ledger sum', async () => {
    expect(await reconcileBalances(db)).toEqual([]);
  });

  it('has a share vector equal to the sum of order shares', async () => {
    const board = await db.select().from(outcomes).where(eq(outcomes.marketId, fx.marketId));
    for (const row of board) {
      const [{ total }] = await db
        .select({ total: sql<string>`coalesce(sum(${orders.sharesMicro}), 0)` })
        .from(orders)
        .where(eq(orders.outcomeId, row.id));
      expect(row.sharesMicro).toBe(BigInt(total));
    }
  });

  it('has positions equal to the sum of order shares per account', async () => {
    const held = await db
      .select()
      .from(positions)
      .where(inArray(positions.outcomeId, fx.outcomeIds));
    for (const p of held) {
      const [{ total }] = await db
        .select({ total: sql<string>`coalesce(sum(${orders.sharesMicro}), 0)` })
        .from(orders)
        .where(and(eq(orders.accountId, p.accountId), eq(orders.outcomeId, p.outcomeId)));
      expect(p.sharesMicro).toBe(BigInt(total));
    }
  });

  it("keeps the maker's balance equal to C(q), so the subsidy bound holds in integers", async () => {
    const [market] = await db.select().from(markets).where(eq(markets.id, fx.marketId));
    const [maker] = await db.select().from(accounts).where(eq(accounts.id, market.makerAccountId));
    const cq = await makerValueMicro(fx.marketId, db);

    // Every cost is rounded in the house's favour, so the maker holds at least
    // C(q) and at most a micro-unit per fill more.
    expect(maker.balanceMicro).toBeGreaterThanOrEqual(cq);
    expect(maker.balanceMicro - cq).toBeLessThanOrEqual(BigInt(TRADES));
    expect(maker.balanceMicro).toBeGreaterThan(0n);
  });

  it('never changed b (§1.3)', async () => {
    const [market] = await db.select().from(markets).where(eq(markets.id, fx.marketId));
    expect(market.b).toBe(fx.b);
  });
});

describe('a concurrent trade that cannot be afforded', () => {
  it('is refused rather than overdrawing', async () => {
    const trader = fx.traderIds[0];
    const [before] = await db.select().from(accounts).where(eq(accounts.id, trader));

    await expect(
      trade(
        trader,
        fx.marketId,
        fx.outcomeIds[0],
        10_000_000_000n, // 10,000 shares against a balance of well under that
        1_000_000_000_000n,
        null,
        db,
      ),
    ).rejects.toThrow(EngineError);

    const [after] = await db.select().from(accounts).where(eq(accounts.id, trader));
    expect(after.balanceMicro).toBe(before.balanceMicro);
  });
});
