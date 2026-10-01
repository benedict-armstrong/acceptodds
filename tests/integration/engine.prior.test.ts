import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { accounts, markets, outcomes } from '@/db/schema';
import { cost, liquidityFor, prices } from '@/lib/lmsr';
import { costToMicro, microToFloat } from '@/lib/money';
import { createHouse, createAccount, reconcileBalances } from '@/server/accounts';
import { createMarket, makerValueMicro, quote, settle, trade } from '@/server/engine';
import { EngineError } from '@/server/errors';
import { priceHistory } from '@/server/views';
import { closePool, HOUSE_MICRO, resetDatabase, STARTING_MICRO } from './helpers';

const db = getDb();
afterAll(closePool);

/** A paper's market: Oral, Spotlight, Poster, Reject, opened at the venue's rates. */
const PRIOR = [0.012, 0.022, 0.241, 0.725];

let traderId: string;
let marketId: string;
let outcomeIds: string[];
let makerId: string;

beforeEach(async () => {
  await resetDatabase();
  await createHouse(HOUSE_MICRO, db);
  traderId = (await createAccount({ handle: 'trader', displayName: 'T', grantMicro: STARTING_MICRO }, db)).id;
  const m = await createMarket(
    {
      slug: 'prior',
      question: 'How will it decide?',
      outcomes: ['Oral', 'Spotlight', 'Poster', 'Reject'],
      closesAt: new Date(Date.now() + 86_400_000),
      startingBalanceMicro: STARTING_MICRO,
      expectedTraders: 10,
      openingPrices: PRIOR,
    },
    db,
  );
  marketId = m.marketId;
  outcomeIds = m.outcomeIds;
  [{ makerId }] = await db.select({ makerId: markets.makerAccountId }).from(markets).where(eq(markets.id, marketId));
}, 60_000);

describe('a market opened at a prior', () => {
  it('opens at the prior, and the house pays b * ln(1 / p_min)', async () => {
    const [market] = await db.select().from(markets).where(eq(markets.id, marketId));
    const rows = await db.select().from(outcomes).where(eq(outcomes.marketId, marketId)).orderBy(outcomes.ordinal);
    prices(
      rows.map((r) => microToFloat(r.sharesMicro)),
      market.b,
    ).forEach((p, i) => expect(p).toBeCloseTo(PRIOR[i], 6));
    expect(rows.map((r) => r.openingSharesMicro)).toEqual(rows.map((r) => r.sharesMicro));
    expect(rows.every((r) => r.sharesMicro >= 0n)).toBe(true);
    expect(market.headline).toBeCloseTo(1 - PRIOR[3], 6);

    const b = liquidityFor(microToFloat(STARTING_MICRO), 10, 4);
    expect(market.b).toBe(b);
    const [maker] = await db.select().from(accounts).where(eq(accounts.id, makerId));
    expect(maker.balanceMicro).toBe(costToMicro(b * Math.log(1 / 0.012)));
    expect(await makerValueMicro(marketId, db)).toBe(maker.balanceMicro);
    expect((await reconcileBalances(db)).length).toBe(0);
  });

  it('quotes at the prior, and a buy moves it', async () => {
    const q = await quote(marketId, outcomeIds[0], 1_000_000n, db);
    expect(q.priceBefore).toBeCloseTo(PRIOR[0], 6);
    expect(q.priceAfter).toBeGreaterThan(q.priceBefore);
  });

  it('replays from the opening vector, not from zeros', async () => {
    await trade(traderId, marketId, outcomeIds[2], 5_000_000n, 10_000_000_000n, null, db);
    const [market] = await db.select().from(markets).where(eq(markets.id, marketId));
    const history = await priceHistory(market, { limit: 10 }, db);
    expect(history.points).toHaveLength(2);
    history.points[0].prices.forEach((p, i) => expect(p).toBeCloseTo(PRIOR[i], 6));
    const rows = await db.select().from(outcomes).where(eq(outcomes.marketId, marketId)).orderBy(outcomes.ordinal);
    const now = prices(
      rows.map((r) => microToFloat(r.sharesMicro)),
      market.b,
    );
    history.points[1].prices.forEach((p, i) => expect(p).toBeCloseTo(now[i], 9));
  });

  it('settles on any outcome with the maker solvent, and all reputation conserved', async () => {
    // Bring the least likely outcome in as far as a trader can afford, then settle on it.
    const fill = await trade(traderId, marketId, outcomeIds[0], 300_000_000n, 10_000_000_000n, null, db);
    expect(fill.costMicro).toBeGreaterThan(0n);
    const [market] = await db.select().from(markets).where(eq(markets.id, marketId));
    const rows = await db.select().from(outcomes).where(eq(outcomes.marketId, marketId));
    const [maker] = await db.select().from(accounts).where(eq(accounts.id, makerId));
    expect(maker.balanceMicro).toBeGreaterThanOrEqual(
      costToMicro(
        cost(
          rows.map((r) => microToFloat(r.sharesMicro)),
          market.b,
        ),
      ),
    );

    await settle(marketId, outcomeIds[0], {}, db);
    const [after] = await db.select().from(accounts).where(eq(accounts.id, makerId));
    expect(after.balanceMicro).toBe(0n);
    expect((await reconcileBalances(db)).length).toBe(0);
    const all = await db.select().from(accounts);
    expect(all.reduce((s, a) => s + a.balanceMicro, 0n)).toBe(HOUSE_MICRO + STARTING_MICRO);
  });

  it('refuses a prior that is not one positive price per outcome summing to 1', async () => {
    for (const openingPrices of [
      [0.5, 0.5],
      [0.5, 0.5, 0, 0],
      [0.4, 0.3, 0.2, 0.2],
      [0.25, 0.25, 0.25, Number.NaN],
    ]) {
      await expect(
        createMarket(
          {
            slug: `bad-${openingPrices.join('-')}`,
            question: 'q',
            outcomes: ['a', 'b', 'c', 'd'],
            closesAt: new Date(Date.now() + 86_400_000),
            startingBalanceMicro: STARTING_MICRO,
            expectedTraders: 10,
            openingPrices,
          },
          db,
        ),
      ).rejects.toBeInstanceOf(EngineError);
    }
  });
});
