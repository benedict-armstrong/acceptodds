import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { accounts } from '@/db/schema';
import { closedPositions } from '@/server/accounts';
import { quote, settle, trade } from '@/server/engine';
import { closePool, resetDatabase, seedMarket, STARTING_MICRO, type Fixture } from './helpers';

const db = getDb();
const UNIT = 1_000_000n;
let fx: Fixture;

beforeEach(async () => {
  await resetDatabase();
  fx = await seedMarket(4, 10);
}, 60_000);

afterAll(async () => {
  await closePool();
});

async function fill(accountId: string, outcomeId: string, sharesMicro: bigint) {
  const q = await quote(fx.marketId, outcomeId, sharesMicro, db);
  return trade(accountId, fx.marketId, outcomeId, sharesMicro, q.costMicro, null, db);
}

async function gain(accountId: string): Promise<bigint> {
  const [a] = await db.select().from(accounts).where(eq(accounts.id, accountId));
  return a.balanceMicro - STARTING_MICRO;
}

describe('closed positions', () => {
  it('lists what was sold out or settled, never what is held, with the ledger’s exact P&L', async () => {
    const [seller, winner, loser, holder] = fx.traderIds;
    const [yes, no] = fx.outcomeIds;
    await fill(seller, yes, 10n * UNIT);
    await fill(seller, yes, -4n * UNIT);
    await fill(seller, yes, -6n * UNIT);
    await fill(winner, yes, 5n * UNIT);
    await fill(loser, no, 3n * UNIT);
    await fill(holder, no, 2n * UNIT);

    const sold = await closedPositions(seller, {}, db);
    expect(sold.total).toBe(1);
    expect(sold.rows[0]).toMatchObject({ outcomeId: yes, closedBy: 'sold', boughtMicro: 10n * UNIT, payoutMicro: 0n });
    // A round trip rounds in the house's favour: never a profit.
    expect(sold.rows[0].pnlMicro).toBe(await gain(seller));
    expect(sold.rows[0].pnlMicro).toBeLessThanOrEqual(0n);
    expect((await closedPositions(winner, {}, db)).total).toBe(0);

    await settle(fx.marketId, yes, {}, db);

    const won = (await closedPositions(winner, {}, db)).rows;
    expect(won).toHaveLength(1);
    expect(won[0]).toMatchObject({ closedBy: 'won', payoutMicro: 5n * UNIT, soldMicro: 0n });
    expect(won[0].pnlMicro).toBe(await gain(winner));

    const lost = (await closedPositions(loser, {}, db)).rows;
    expect(lost[0]).toMatchObject({ closedBy: 'lost', payoutMicro: 0n });
    expect(lost[0].pnlMicro).toBe(-lost[0].paidMicro);
    expect(lost[0].pnlMicro).toBe(await gain(loser));

    // Selling out before settlement stays "sold".
    expect((await closedPositions(seller, {}, db)).rows[0].closedBy).toBe('sold');
  });

  it('pages newest first, with a total', async () => {
    const [a] = fx.traderIds;
    const [yes, no] = fx.outcomeIds;
    await fill(a, yes, UNIT);
    await fill(a, yes, -UNIT);
    await fill(a, no, UNIT);
    await fill(a, no, -UNIT);
    const first = await closedPositions(a, { limit: 1 }, db);
    expect(first.total).toBe(2);
    expect(first.rows.map((r) => r.outcomeId)).toEqual([no]);
    expect((await closedPositions(a, { limit: 1, offset: 1 }, db)).rows.map((r) => r.outcomeId)).toEqual([yes]);
  });
});
