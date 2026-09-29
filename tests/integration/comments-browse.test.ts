import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createMarket } from '@/server/engine';
import { browseListings, marketKinds, sparklines } from '@/server/views';
import { api, trader } from './api-client';
import { closePool, resetDatabase, seedMarket, STARTING_MICRO, type Fixture } from './helpers';

let fx: Fixture;

beforeEach(async () => {
  await resetDatabase();
  process.env.API_RATE_LIMIT_BURST = '1000';
  process.env.API_RATE_LIMIT_PER_SECOND = '1000';
  fx = await seedMarket(0, 10);
}, 60_000);

afterAll(async () => {
  await closePool();
});

const buy = (token: string, outcomeId: string, sharesMicro: string, marketId = fx.marketId) =>
  api('POST', `/markets/${marketId}/orders`, { token, body: { outcomeId, sharesMicro, maxCostMicro: '1000000000' } });

describe('comments', () => {
  it('are anonymous: a stake and a bot flag, never a handle or an account id', async () => {
    const t = await trader('secret-handle');
    await buy(t.token, fx.outcomeIds[0], '40000000');
    const posted = await api('POST', `/markets/${fx.marketId}/comments`, { token: t.token, body: { body: '  I think so.  ' } });
    expect(posted.status).toBe(201);
    expect(posted.body).toMatchObject({
      body: 'I think so.',
      author: { isBot: false, isYou: true, stake: [{ outcomeLabel: 'YES', sharesMicro: '40000000' }] },
    });

    const list = await api('GET', `/markets/${fx.marketId}/comments`);
    expect(list.status).toBe(200);
    expect(list.body.comments[0].author).toEqual({
      isBot: false,
      isYou: false,
      stake: [{ outcomeId: fx.outcomeIds[0], outcomeLabel: 'YES', sharesMicro: '40000000' }],
    });
    const raw = JSON.stringify(list.body);
    expect(raw).not.toContain('secret-handle');
    expect(raw).not.toContain(t.id);
  });

  it('show the current stake, which moves as the author trades', async () => {
    const t = await trader('mover');
    await api('POST', `/markets/${fx.marketId}/comments`, { token: t.token, body: { body: 'no position yet' } });
    expect((await api('GET', `/markets/${fx.marketId}/comments`)).body.comments[0].author.stake).toEqual([]);
    await buy(t.token, fx.outcomeIds[1], '5000000');
    expect((await api('GET', `/markets/${fx.marketId}/comments`)).body.comments[0].author.stake).toEqual([
      { outcomeId: fx.outcomeIds[1], outcomeLabel: 'NO', sharesMicro: '5000000' },
    ]);
  });

  it('flag bots', async () => {
    const bot = await trader('robo', ['read', 'trade'], { isBot: true });
    await api('POST', `/markets/${fx.marketId}/comments`, { token: bot.token, body: { body: 'beep' } });
    expect((await api('GET', `/markets/${fx.marketId}/comments`)).body.comments[0].author.isBot).toBe(true);
  });

  it('need the trade scope and a trading-eligible account, and a sane body', async () => {
    const reader = await trader('reader', ['read']);
    const unverified = await trader('unverified', ['read', 'trade'], { verified: false });
    const ok = await trader('ok');
    expect((await api('POST', `/markets/${fx.marketId}/comments`, { body: { body: 'x' } })).status).toBe(401);
    expect((await api('POST', `/markets/${fx.marketId}/comments`, { token: reader.token, body: { body: 'x' } })).status).toBe(403);
    const nv = await api('POST', `/markets/${fx.marketId}/comments`, { token: unverified.token, body: { body: 'x' } });
    expect(nv.body.error.code).toBe('not_verified');
    for (const body of ['', '   ', 'x'.repeat(2001)]) {
      const res = await api('POST', `/markets/${fx.marketId}/comments`, { token: ok.token, body: { body } });
      expect(res.status).toBe(400);
    }
    expect((await api('POST', '/markets/nope/comments', { token: ok.token, body: { body: 'x' } })).status).toBe(404);
  });

  it('page newest first without repeats', async () => {
    const t = await trader('chatty');
    for (let i = 0; i < 5; i += 1) {
      await api('POST', `/markets/${fx.marketId}/comments`, { token: t.token, body: { body: `c${i}` } });
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const res: { body: { comments: { body: string }[]; nextCursor: string | null } } = await api(
        'GET',
        `/markets/${fx.marketId}/comments?limit=2${cursor ? `&cursor=${cursor}` : ''}`,
      );
      seen.push(...res.body.comments.map((c) => c.body));
      cursor = res.body.nextCursor;
    } while (cursor);
    expect(seen).toEqual(['c4', 'c3', 'c2', 'c1', 'c0']);
  });
});

describe('browsing markets', () => {
  async function extra(slug: string, kind: string, closesInDays: number) {
    return createMarket({
      slug,
      question: slug,
      kind,
      outcomes: ['YES', 'NO'],
      closesAt: new Date(Date.now() + closesInDays * 86_400_000),
      startingBalanceMicro: STARTING_MICRO,
      expectedTraders: 10,
    });
  }

  it('filters by kind and status, and sorts by closing, volume, activity and newest', async () => {
    const a = await extra('a', 'ICLR 2027', 30);
    const b = await extra('b', 'ICLR 2027', 10);
    const c = await extra('c', 'NeurIPS 2026', 5);
    const t = await trader('t');
    await buy(t.token, a.outcomeIds[0], '50000000', a.marketId); // most volume
    await buy(t.token, b.outcomeIds[0], '5000000', b.marketId); // most recent

    const slugs = async (q: Parameters<typeof browseListings>[0]) => (await browseListings(q)).map((r) => r.market.slug);
    expect(await slugs({ kind: 'ICLR 2027', sort: 'closing' })).toEqual(['b', 'a']);
    expect(await slugs({ kind: 'ICLR 2027', sort: 'volume' })).toEqual(['a', 'b']);
    expect(await slugs({ kind: 'ICLR 2027', sort: 'activity' })).toEqual(['b', 'a']);
    expect(await slugs({ kind: 'ICLR 2027', sort: 'newest' })).toEqual(['b', 'a']);
    expect(await slugs({ kind: null, sort: 'closing' })).toEqual(['concurrency', 'c', 'b', 'a']);
    expect(await slugs({ kind: 'NeurIPS 2026', status: 'settled', sort: 'closing' })).toEqual([]);
    void c;

    expect(await marketKinds()).toEqual([
      { kind: 'ICLR 2027', count: 2 },
      { kind: 'NeurIPS 2026', count: 1 },
      { kind: 'binary', count: 1 },
    ]);
  });

  it('builds sparklines from real fills only', async () => {
    const t = await trader('s');
    await buy(t.token, fx.outcomeIds[0], '10000000');
    await buy(t.token, fx.outcomeIds[1], '30000000');
    const rows = await browseListings({ kind: null, sort: 'closing' });
    const sp = await sparklines(rows);
    const line = sp.get(fx.marketId)!;
    expect(line).toHaveLength(3);
    expect(line[0]).toBe(0.5); // the opening price
    expect(line[1]).toBeGreaterThan(0.5); // YES bought
    expect(line[2]).toBeLessThan(line[1]); // then NO bought
    expect(line[2]).toBeCloseTo(rows[0].outcomes[0].price, 12);
  });
});
