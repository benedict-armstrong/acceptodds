import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '@/db';
import { getPortfolio } from '@/server/accounts';
import { createMarket, quote, settle, trade } from '@/server/engine';
import { valuations } from '@/server/valuation';
import { closePool, resetDatabase, seedMarket, STARTING_MICRO, TEST_KIND, type Fixture } from './helpers';

const db = getDb();
let fx: Fixture;

beforeEach(async () => {
  await resetDatabase();
  fx = await seedMarket(5, 10);
}, 60_000);

afterAll(async () => {
  await closePool();
});

async function buy(accountId: string, marketId: string, outcomeId: string, sharesMicro: bigint) {
  const q = await quote(marketId, outcomeId, sharesMicro, db);
  return trade(accountId, marketId, outcomeId, sharesMicro, q.costMicro, null, db);
}

describe('batch valuation', () => {
  it('equals getPortfolio’s liquidation value per venue, holding by holding, for many accounts at once', async () => {
    const [a, b, c, d] = fx.traderIds;
    const three = await createMarket(
      {
        slug: 'three-way',
        // Another venue: its trades open wallets of their own.
        kind: 'Other',
        question: 'Which one?',
        outcomes: ['X', 'Y', 'Z'],
        closesAt: new Date(Date.now() + 86_400_000),
        startingBalanceMicro: STARTING_MICRO,
        expectedTraders: 10,
        status: 'open',
      },
      db,
    );
    const settled = await createMarket(
      {
        slug: 'done',
        question: 'Done?',
        outcomes: ['YES', 'NO'],
        closesAt: new Date(Date.now() + 86_400_000),
        startingBalanceMicro: STARTING_MICRO,
        expectedTraders: 10,
        status: 'open',
      },
      db,
    );

    await buy(a, fx.marketId, fx.outcomeIds[0], 123_456_789n);
    await buy(a, three.marketId, three.outcomeIds[2], 7_000_001n);
    await buy(b, fx.marketId, fx.outcomeIds[1], 55_500_000n);
    await buy(b, fx.marketId, fx.outcomeIds[0], 3_000_000n);
    await buy(c, three.marketId, three.outcomeIds[0], 250_000_000n);
    await buy(c, three.marketId, three.outcomeIds[1], 40_000_000n);
    // A partial sell: trade rows on an open market net against the holding.
    await buy(c, three.marketId, three.outcomeIds[0], -100_000_000n);
    await buy(d, settled.marketId, settled.outcomeIds[0], 30_000_000n);
    await buy(a, settled.marketId, settled.outcomeIds[1], 10_000_000n);
    await settle(settled.marketId, settled.outcomeIds[0], {}, db);

    const batch = await valuations(TEST_KIND, undefined, db);
    const other = await valuations('Other', undefined, db);
    // Every non-house account with a wallet in the venue, and only those.
    expect([...batch.keys()].sort()).toEqual([...fx.traderIds].sort());
    expect([...other.keys()].sort()).toEqual([a, c].sort());

    for (const id of fx.traderIds) {
      const p = await getPortfolio(id, db);
      expect(p.wallets.map((w) => w.kind)).toEqual(other.has(id) ? ['Other', TEST_KIND] : [TEST_KIND]);
      for (const w of p.wallets) {
        const v = (w.kind === TEST_KIND ? batch : other).get(id)!;
        expect(v.netWorthMicro).toBe(w.netWorthMicro);
        expect(v.cashMicro).toBe(w.cashMicro);
        expect(v.holdingsValueMicro).toBe(
          p.holdings.filter((h) => h.kind === w.kind).reduce((s, h) => s + h.quotedExitMicro, 0n),
        );
        expect(v.unrealizedPnlMicro).toBe(w.unrealizedPnlMicro);
        expect(v.realizedPnlMicro).toBe(w.realizedPnlMicro);
        // Starting balance = net worth − unrealized − realized, in each wallet: every movement is accounted for.
        expect(v.netWorthMicro - v.unrealizedPnlMicro - v.realizedPnlMicro).toBe(STARTING_MICRO);
      }
    }

    // The settled market's P&L is realized, and nothing of it is left open.
    expect(batch.get(d)!.realizedPnlMicro).toBeGreaterThan(0n);
    expect(batch.get(d)!.unrealizedPnlMicro).toBe(0n);
    expect(batch.get(d)!.settledMarkets).toBe(1);
    // An account that never traded is worth its grant.
    expect(batch.get(fx.traderIds[4])!.netWorthMicro).toBe(STARTING_MICRO);

    // Asking for a subset returns just those.
    const some = await valuations(TEST_KIND, [a, c], db);
    expect([...some.keys()].sort()).toEqual([a, c].sort());
    expect(some.get(a)!.netWorthMicro).toBe(batch.get(a)!.netWorthMicro);
  });
});
