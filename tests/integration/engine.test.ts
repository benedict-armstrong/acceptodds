import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { getDb } from '@/db';
import { ledgerEntries, markets, orders, outcomes, positions, wallets } from '@/db/schema';
import { getPortfolio } from '@/server/accounts';
import { reconcileBalances, walletFor } from '@/server/wallets';
import { closeMarket, createMarket, quote, settle, trade } from '@/server/engine';
import {
  balanceOf,
  closePool,
  resetDatabase,
  seedMarket,
  STARTING_MICRO,
  TEST_KIND,
  totalBalance,
  type Fixture,
} from './helpers';

const db = getDb();

let fx: Fixture;

beforeEach(async () => {
  await resetDatabase();
  fx = await seedMarket(3);
}, 60_000);

afterAll(async () => {
  await closePool();
});

describe('quote', () => {
  it('never writes', async () => {
    const before = await db.select().from(outcomes).where(eq(outcomes.marketId, fx.marketId));
    const q = await quote(fx.marketId, fx.outcomeIds[0], 5_000_000n, db);
    expect(q.costMicro).toBeGreaterThan(0n);
    expect(q.priceAfter).toBeGreaterThan(q.priceBefore);

    const after = await db.select().from(outcomes).where(eq(outcomes.marketId, fx.marketId));
    expect(after).toEqual(before);
    expect(await db.select().from(orders)).toEqual([]);
    expect(await db.select().from(ledgerEntries).where(eq(ledgerEntries.reason, 'trade'))).toEqual([]);
  });

  it('prices the whole size, not shares x price', async () => {
    const small = await quote(fx.marketId, fx.outcomeIds[0], 1_000_000n, db);
    const big = await quote(fx.marketId, fx.outcomeIds[0], 100_000_000n, db);
    const smallPerShare = Number(small.costMicro) / 1e6;
    const bigPerShare = Number(big.costMicro) / 1e8;
    // Slippage: buying more costs strictly more per share.
    expect(bigPerShare).toBeGreaterThan(smallPerShare);
  });
});

describe('maxCostMicro', () => {
  it('rejects a fill that re-prices above the limit, and writes nothing', async () => {
    const q = await quote(fx.marketId, fx.outcomeIds[0], 10_000_000n, db);
    // Someone else moves the market first.
    await trade(fx.traderIds[1], fx.marketId, fx.outcomeIds[0], 200_000_000n, 10n ** 12n, null, db);

    const before = await totalBalance();
    await expect(
      trade(fx.traderIds[0], fx.marketId, fx.outcomeIds[0], 10_000_000n, q.costMicro, null, db),
    ).rejects.toMatchObject({ code: 'slippage_exceeded' });

    expect(await totalBalance()).toBe(before);
    const mine = await db.select().from(orders).where(eq(orders.accountId, fx.traderIds[0]));
    expect(mine).toEqual([]);
  });

  it('accepts a fill at exactly the limit', async () => {
    const q = await quote(fx.marketId, fx.outcomeIds[0], 10_000_000n, db);
    const fill = await trade(fx.traderIds[0], fx.marketId, fx.outcomeIds[0], 10_000_000n, q.costMicro, null, db);
    expect(fill.costMicro).toBe(q.costMicro);
  });
});

describe('idempotency', () => {
  it('returns the original fill on a retry instead of trading twice', async () => {
    const key = 'bot-retry-1';
    const first = await trade(fx.traderIds[0], fx.marketId, fx.outcomeIds[0], 7_000_000n, 10n ** 12n, key, db);
    const second = await trade(fx.traderIds[0], fx.marketId, fx.outcomeIds[0], 7_000_000n, 10n ** 12n, key, db);

    expect(second.orderId).toBe(first.orderId);
    expect(second.replayed).toBe(true);
    expect(second.costMicro).toBe(first.costMicro);

    const all = await db.select().from(orders).where(eq(orders.accountId, fx.traderIds[0]));
    expect(all).toHaveLength(1);
  });

  it('survives a retry that races the original', async () => {
    const key = 'bot-retry-race';
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        trade(fx.traderIds[0], fx.marketId, fx.outcomeIds[0], 3_000_000n, 10n ** 12n, key, db),
      ),
    );
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled).toHaveLength(5);
    const all = await db.select().from(orders).where(eq(orders.accountId, fx.traderIds[0]));
    expect(all).toHaveLength(1);
  });

  it('survives a retry that races the original on a different market', async () => {
    // Different markets take different row locks, so the in-lock replay check
    // cannot see the other attempt: the unique index is the only guard, and
    // its violation must come back as the original fill, not as an error.
    const other = await createMarket(
      {
        slug: 'other',
        question: 'Another?',
        outcomes: ['YES', 'NO'],
        closesAt: new Date(Date.now() + 86_400_000),
        startingBalanceMicro: STARTING_MICRO,
        expectedTraders: 3,
      },
      db,
    );
    for (let round = 0; round < 5; round += 1) {
      const key = `cross-market-${round}`;
      const results = await Promise.allSettled([
        trade(fx.traderIds[0], fx.marketId, fx.outcomeIds[0], 1_000_000n, 10n ** 12n, key, db),
        trade(fx.traderIds[0], other.marketId, other.outcomeIds[0], 1_000_000n, 10n ** 12n, key, db),
      ]);
      expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
      const fills = results.map((r) => (r as PromiseFulfilledResult<Awaited<ReturnType<typeof trade>>>).value);
      expect(fills[0].orderId).toBe(fills[1].orderId);
    }
    const all = await db.select().from(orders).where(eq(orders.accountId, fx.traderIds[0]));
    expect(all).toHaveLength(5);
  });
});

describe('selling', () => {
  it('is a trade with negative shares, on the same code path', async () => {
    await trade(fx.traderIds[0], fx.marketId, fx.outcomeIds[0], 20_000_000n, 10n ** 12n, null, db);
    const sale = await trade(fx.traderIds[0], fx.marketId, fx.outcomeIds[0], -20_000_000n, 0n, null, db);
    expect(sale.costMicro).toBeLessThan(0n);
    expect(sale.positionAfterMicro).toBe(0n);
    expect(await reconcileBalances(db)).toEqual([]);
  });

  it('refuses to sell shares that are not held', async () => {
    await expect(
      trade(fx.traderIds[0], fx.marketId, fx.outcomeIds[0], -1_000_000n, 0n, null, db),
    ).rejects.toMatchObject({ code: 'insufficient_shares' });
  });

  it('leaves the round trip costing the trader something, never paying them (§1.1)', async () => {
    const before = await balanceOf(fx.traderIds[0]);
    await trade(fx.traderIds[0], fx.marketId, fx.outcomeIds[0], 25_000_000n, 10n ** 12n, null, db);
    await trade(fx.traderIds[0], fx.marketId, fx.outcomeIds[0], -25_000_000n, 0n, null, db);
    expect(await balanceOf(fx.traderIds[0])).toBeLessThanOrEqual(before);
  });
});

describe('portfolio (§1.1)', () => {
  it('reports the mark and the quoted exit value as separate, different numbers', async () => {
    await trade(fx.traderIds[0], fx.marketId, fx.outcomeIds[0], 150_000_000n, 10n ** 12n, null, db);
    const portfolio = await getPortfolio(fx.traderIds[0], db);

    expect(portfolio.holdings).toHaveLength(1);
    const holding = portfolio.holdings[0];
    // The mark is what the position is valued at; the exit is what closing it
    // pays. The second is strictly smaller, and that is the whole point.
    expect(holding.quotedExitMicro).toBeLessThan(holding.markMicro);
    const [wallet] = portfolio.wallets;
    expect(wallet.kind).toBe(TEST_KIND);
    expect(wallet.netWorthMicro).toBeLessThan(wallet.markedNetWorthMicro);
  });
});

describe('a closed market', () => {
  it('refuses trades', async () => {
    await closeMarket(fx.marketId, db);
    await expect(
      trade(fx.traderIds[0], fx.marketId, fx.outcomeIds[0], 1_000_000n, 10n ** 12n, null, db),
    ).rejects.toMatchObject({ code: 'market_not_open' });
  });
});

describe('settlement', () => {
  it('pays 1 unit per winning share, zeroes positions and conserves reputation', async () => {
    await trade(fx.traderIds[0], fx.marketId, fx.outcomeIds[0], 40_000_000n, 10n ** 12n, null, db);
    await trade(fx.traderIds[1], fx.marketId, fx.outcomeIds[1], 30_000_000n, 10n ** 12n, null, db);
    await trade(fx.traderIds[2], fx.marketId, fx.outcomeIds[0], 10_000_000n, 10n ** 12n, null, db);

    const winnerBefore = await balanceOf(fx.traderIds[0]);
    await closeMarket(fx.marketId, db);
    await settle(fx.marketId, fx.outcomeIds[0], { evidenceUrl: 'https://example.invalid/x' }, db);

    expect((await balanceOf(fx.traderIds[0])) - winnerBefore).toBe(40_000_000n);

    const held = await db.select().from(positions).where(inArray(positions.outcomeId, fx.outcomeIds));
    expect(held.every((p) => p.sharesMicro === 0n)).toBe(true);

    const [market] = await db.select().from(markets).where(eq(markets.id, fx.marketId));
    expect(market.status).toBe('settled');
    expect(market.resolvedOutcomeId).toBe(fx.outcomeIds[0]);
    expect(market.settledAt).toBeInstanceOf(Date);

    // §1.7: nothing was created or destroyed anywhere along the way.
    expect(await totalBalance()).toBe(fx.grantedMicro);
    expect(await reconcileBalances(db)).toEqual([]);

    // The maker closed at zero: its residual went back to the treasury.
    expect(await balanceOf(market.makerAccountId)).toBe(0n);

    const negative = await db
      .select()
      .from(wallets)
      .where(sql`${wallets.balanceMicro} < 0`);
    expect(negative).toEqual([]);
  });

  it('is idempotent: a second run settles nothing', async () => {
    await trade(fx.traderIds[0], fx.marketId, fx.outcomeIds[0], 40_000_000n, 10n ** 12n, null, db);
    await settle(fx.marketId, fx.outcomeIds[0], {}, db);

    const snapshot = await totalBalance();
    const entries = await db.select().from(ledgerEntries);

    await settle(fx.marketId, fx.outcomeIds[0], {}, db);
    await settle(fx.marketId, fx.outcomeIds[1], {}, db);

    expect(await totalBalance()).toBe(snapshot);
    expect(await db.select().from(ledgerEntries)).toHaveLength(entries.length);
  });
});

describe('wallets, one per venue', () => {
  async function otherVenueMarket() {
    return createMarket(
      {
        slug: 'elsewhere',
        kind: 'Elsewhere',
        question: 'Will it, elsewhere?',
        outcomes: ['YES', 'NO'],
        closesAt: new Date(Date.now() + 86_400_000),
        startingBalanceMicro: STARTING_MICRO,
        expectedTraders: 3,
      },
      db,
    );
  }

  it('a first trade in a venue opens its wallet with the grant, and touches no other venue', async () => {
    const other = await otherVenueMarket();
    const [t] = fx.traderIds;
    await trade(t, fx.marketId, fx.outcomeIds[0], 10_000_000n, 10n ** 12n, null, db);
    const home = await balanceOf(t);
    expect(await walletFor(db, t, 'Elsewhere')).toBeNull();

    const fill = await trade(t, other.marketId, other.outcomeIds[1], 20_000_000n, 10n ** 12n, null, db);
    expect(fill.balanceAfterMicro).toBe(STARTING_MICRO - fill.costMicro);
    expect(await balanceOf(t, 'Elsewhere')).toBe(fill.balanceAfterMicro);
    expect(await balanceOf(t)).toBe(home);

    // Settlement pays into the venue's wallet, and only there.
    await settle(other.marketId, other.outcomeIds[1], {}, db);
    expect(await balanceOf(t, 'Elsewhere')).toBe(fill.balanceAfterMicro + 20_000_000n);
    expect(await balanceOf(t)).toBe(home);

    // §1.7 still holds, counting the new wallet's grant.
    expect(await totalBalance()).toBe(fx.grantedMicro + STARTING_MICRO);
    expect(await reconcileBalances(db)).toEqual([]);
  });

  it('never spends one venue’s reputation in another', async () => {
    const other = await otherVenueMarket();
    const [t] = fx.traderIds;
    // Spend most of the grant in the other venue …
    const q = await quote(other.marketId, other.outcomeIds[0], 900_000_000n, db);
    expect(q.costMicro).toBeLessThan(STARTING_MICRO);
    await trade(t, other.marketId, other.outcomeIds[0], 900_000_000n, q.costMicro, null, db);
    const left = await balanceOf(t, 'Elsewhere');
    // … and what is left there is all it has there, whatever it holds here.
    const big = await quote(other.marketId, other.outcomeIds[0], 900_000_000n, db);
    expect(big.costMicro).toBeGreaterThan(left);
    await expect(
      trade(t, other.marketId, other.outcomeIds[0], 900_000_000n, big.costMicro, null, db),
    ).rejects.toMatchObject({ code: 'insufficient_balance' });
    expect(await balanceOf(t)).toBe(STARTING_MICRO);
  });

  it('opens exactly one wallet however many first trades race', async () => {
    const other = await otherVenueMarket();
    const [t] = fx.traderIds;
    await Promise.all(
      Array.from({ length: 6 }, () => trade(t, other.marketId, other.outcomeIds[0], 1_000_000n, 10n ** 12n, null, db)),
    );
    const opened = await db.select().from(wallets).where(eq(wallets.kind, 'Elsewhere'));
    // The trader's, and the market's maker's.
    expect(opened).toHaveLength(2);
    const grants = await db
      .select()
      .from(ledgerEntries)
      .where(and(eq(ledgerEntries.accountId, t), eq(ledgerEntries.reason, 'signup')));
    expect(grants).toHaveLength(2);
    expect(await reconcileBalances(db)).toEqual([]);
  });
});

describe('b (§1.3)', () => {
  it('is frozen: no engine call rewrites it', async () => {
    const [before] = await db.select().from(markets).where(eq(markets.id, fx.marketId));
    await trade(fx.traderIds[0], fx.marketId, fx.outcomeIds[0], 90_000_000n, 10n ** 12n, null, db);
    await closeMarket(fx.marketId, db);
    await settle(fx.marketId, fx.outcomeIds[0], {}, db);
    const [after] = await db.select().from(markets).where(eq(markets.id, fx.marketId));
    expect(after.b).toBe(before.b);
    expect(after.b).toBe(fx.b);
  });
});

describe('the event log (§1.4)', () => {
  it('records reads and writes without a payload, and never blocks a trade', async () => {
    await trade(fx.traderIds[0], fx.marketId, fx.outcomeIds[0], 1_000_000n, 10n ** 12n, null, db);
    // The log is fire-and-forget, so give it a moment.
    await new Promise((r) => setTimeout(r, 250));
    const rows = await db.execute(sql`select * from events limit 1`);
    const columns = Object.keys(rows.rows[0] ?? {});
    expect(columns).not.toContain('payload');
    expect(columns.sort()).toEqual(['account_id', 'created_at', 'id', 'kind', 'market_id']);
  });
});
