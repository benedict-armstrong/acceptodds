import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDb, getPool, type Database } from '@/db';
import { getPortfolio } from '@/server/accounts';
import { closeMarket, createMarket, quote, settle, trade } from '@/server/engine';
import { fieldSnapshot } from '@/server/field-snapshot';
import { headlinePrice } from '@/lib/headline';
import { leaderboardStandings, marketTape, marketView, priceHistory, resolveMarket, sparklines } from '@/server/views';
import { valuation } from '@/server/valuation';
import { api, trader } from './api-client';
import { closePool, resetDatabase, seedMarket, STARTING_MICRO, type Fixture } from './helpers';

const db = getDb();
let fx: Fixture;

beforeEach(async () => {
  await resetDatabase();
  fx = await seedMarket(3, 10);
  process.env.API_RATE_LIMIT_BURST = '1000';
  process.env.API_RATE_LIMIT_PER_SECOND = '1000';
});
afterAll(closePool);

function selectCount(spy: { mock: { calls: unknown[][] } }) {
  return spy.mock.calls.filter((call) => {
    const arg = call[0] as string | { text: string };
    return /^\s*(select|with)\b/i.test(typeof arg === 'string' ? arg : arg.text);
  }).length;
}

const makeMarket = (slug: string) =>
  createMarket({
    slug,
    question: slug,
    outcomes: ['A', 'B', 'C', 'D'],
    openingPrices: [0.1, 0.2, 0.3, 0.4],
    closesAt: new Date(Date.now() + 86_400_000),
    startingBalanceMicro: STARTING_MICRO,
    expectedTraders: 10,
    status: 'open',
  });

describe('read workload and correctness', () => {
  it('loads twenty holdings in six queries and preserves exact exit quotes and filtered totals', async () => {
    const created: Awaited<ReturnType<typeof makeMarket>>[] = [];
    for (let i = 0; i < 5; i++) {
      const m = await makeMarket(`many-${i}`);
      created.push(m);
      for (const outcomeId of m.outcomeIds) {
        await trade(fx.traderIds[0], m.marketId, outcomeId, 1_000_001n, STARTING_MICRO);
      }
    }
    const spy = vi.spyOn(getPool(), 'query');
    let portfolio;
    try {
      portfolio = await getPortfolio(fx.traderIds[0]);
      expect(selectCount(spy)).toBe(6);
    } finally {
      spy.mockRestore();
    }
    expect(portfolio.holdings).toHaveLength(20);
    for (const h of portfolio.holdings) {
      const q = await quote(h.marketId, h.outcomeId, -h.sharesMicro);
      expect(h.quotedExitMicro).toBe(-q.costMicro);
    }
    expect((await valuation(fx.traderIds[0]))!.netWorthMicro).toBe(portfolio.liquidationValueMicro);
    const filtered = await getPortfolio(fx.traderIds[0], db, created[0].marketId);
    expect(filtered.holdings).toEqual(portfolio.holdings.filter((h) => h.marketId === created[0].marketId));
    expect(filtered.summary).toEqual(portfolio.summary);
    expect(filtered.markedNetWorthMicro).toBe(portfolio.markedNetWorthMicro);
    expect(filtered.liquidationValueMicro).toBe(portfolio.liquidationValueMicro);
  });

  it('filters the authenticated portfolio on the wire without exposing another account', async () => {
    const bot = await trader('portfolio-reader', ['read'], { isBot: true });
    await trade(bot.id, fx.marketId, fx.outcomeIds[0], 1_000_000n, STARTING_MICRO);
    const other = await makeMarket('other');
    await trade(bot.id, other.marketId, other.outcomeIds[0], 2_000_000n, STARTING_MICRO);
    const all = await api('GET', '/me/portfolio', { token: bot.token });
    const filtered = await api('GET', `/me/portfolio?marketId=${fx.marketId}`, { token: bot.token });
    expect(filtered.status).toBe(200);
    expect(filtered.body.holdings).toHaveLength(1);
    expect(filtered.body.holdings[0].marketId).toBe(fx.marketId);
    expect(filtered.body.summary).toEqual(all.body.summary);
    expect(filtered.body.unsettledValuation).toEqual(all.body.unsettledValuation);
    expect((await api('GET', '/me/portfolio?marketId=bad', { token: bot.token })).status).toBe(400);
    expect((await api('GET', `/me/portfolio?marketId=${fx.marketId}`)).status).toBe(401);
  });

  it('shares public reads and invalidates slug and id aliases immediately after writes', async () => {
    const market = await resolveMarket(fx.marketId);
    await resolveMarket(market.slug);
    const [a, b] = await Promise.all([marketView(market), marketView(market)]);
    expect(a).toBe(b);
    const tape = await marketTape(market, { limit: 10 });
    expect(await marketTape(market, { limit: 10 })).toBe(tape);
    await trade(fx.traderIds[0], fx.marketId, fx.outcomeIds[0], 1_000_000n, STARTING_MICRO);
    const current = await resolveMarket(market.slug);
    expect(current.orderCount).toBe(1);
    expect((await marketView(current)).outcomes[0].price).not.toBe(a.outcomes[0].price);
    expect((await marketTape(current, { limit: 10 })).rows).toHaveLength(1);
    await closeMarket(fx.marketId);
    expect((await resolveMarket(fx.marketId)).status).toBe('closed');
    await settle(fx.marketId, fx.outcomeIds[0]);
    expect((await resolveMarket(market.slug)).status).toBe('settled');
    // A bad credential must still fail even when the public data is warm.
    expect((await api('GET', `/markets/${fx.marketId}`, { token: 'invalid' })).status).toBe(401);
  });

  it('bounds sparkline replay and preserves priors, sells, and ordering', async () => {
    const m = await makeMarket('spark');
    for (let i = 0; i < 9; i++) {
      await trade(fx.traderIds[0], m.marketId, m.outcomeIds[i % 4], 2_000_001n, STARTING_MICRO);
    }
    await trade(fx.traderIds[0], m.marketId, m.outcomeIds[0], -1_000_000n, 0n);
    const market = await resolveMarket(m.marketId);
    const view = await marketView(market);
    const history = await priceHistory(market, { limit: 100 });
    const expected = history.points.map((p) => headlinePrice(p.prices));
    expect((await sparklines([view], 4)).get(m.marketId)).toEqual(expected.slice(-4));
    expect((await sparklines([view], 40)).get(m.marketId)).toEqual(expected);
    const spy = vi.spyOn(getPool(), 'query');
    try {
      await sparklines([view], 4);
      expect(selectCount(spy)).toBe(0);
    } finally {
      spy.mockRestore();
    }
    await trade(fx.traderIds[1], m.marketId, m.outcomeIds[3], 1_000_000n, STARTING_MICRO);
    // Even a caller holding an older view gets a fresh, internally consistent sparkline after invalidation.
    const next = (await sparklines([view], 4)).get(m.marketId)!;
    expect(next).not.toEqual(expected.slice(-4));
    expect(next.at(-1)).toBeCloseTo(
      headlinePrice((await marketView(await resolveMarket(m.marketId))).outcomes.map((o) => o.price)),
      12,
    );
  });

  it('incremental ranks equal a fresh transaction after cross-market fills and settlement', async () => {
    const other = await makeMarket('rank-other');
    await trade(fx.traderIds[0], fx.marketId, fx.outcomeIds[0], 10_000_000n, STARTING_MICRO);
    await trade(fx.traderIds[1], fx.marketId, fx.outcomeIds[1], 12_000_000n, STARTING_MICRO);
    await trade(fx.traderIds[2], other.marketId, other.outcomeIds[0], 5_000_000n, STARTING_MICRO);
    const before = await leaderboardStandings({ basis: 'net_worth' });
    const unrelated = before.find((r) => r.accountId === fx.traderIds[2])!;
    for (const shares of [1_000_001n, -11_000_001n]) {
      await trade(fx.traderIds[0], fx.marketId, fx.outcomeIds[0], shares, STARTING_MICRO);
      const incremental = await leaderboardStandings({ basis: 'net_worth' });
      const full = await db.transaction((tx) =>
        leaderboardStandings({ basis: 'net_worth' }, tx as unknown as Database),
      );
      expect(incremental).toEqual(full);
      expect(incremental.find((r) => r.accountId === unrelated.accountId)).toEqual({
        ...unrelated,
        rank: expect.any(Number),
      });
    }
    await settle(fx.marketId, fx.outcomeIds[1]);
    for (const basis of ['net_worth', 'settled_pnl'] as const) {
      expect(await leaderboardStandings({ basis })).toEqual(
        await db.transaction((tx) => leaderboardStandings({ basis }, tx as unknown as Database)),
      );
    }
  });

  it('shares snapshot reads in memory', async () => {
    await fieldSnapshot();
    await fieldSnapshot();
    const spy = vi.spyOn(getPool(), 'query');
    try {
      await Promise.all([fieldSnapshot(), fieldSnapshot()]);
      expect(selectCount(spy)).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });
});
