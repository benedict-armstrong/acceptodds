/* eslint-disable @typescript-eslint/no-explicit-any -- response bodies are checked field by field */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { listingTexts, markets, usdCosts } from '@/db/schema';
import { followedListingIds, followOpenedListings, unfollow } from '@/server/follows';
import { setRelated, setText, upsertListing } from '@/server/listings';
import { ANONYMOUS_OPEN_BUDGET, OPEN_BUDGET } from '@/server/market-start';
import { consume } from '@/server/ratelimit';
import { browseListings, marketKinds } from '@/server/views';
import { api, trader } from './api-client';
import { closePool, resetDatabase, seedMarket, STARTING_MICRO } from './helpers';

const db = getDb();
const realFetch = globalThis.fetch;

beforeEach(async () => {
  // The ICLR 2027 template closes on 2026-12-14: trade before it, whenever this runs.
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-01T00:00:00Z') });
  await resetDatabase();
  process.env.API_RATE_LIMIT_BURST = '1000';
  process.env.API_RATE_LIMIT_PER_SECOND = '1000';
  process.env.STARTING_BALANCE_MICRO = STARTING_MICRO.toString();
  delete process.env.NANOGPT_API_KEY;
  await seedMarket(0, 10);
}, 60_000);

afterEach(() => {
  vi.useRealTimers();
  globalThis.fetch = realFetch;
  delete process.env.NANOGPT_API_KEY;
});

afterAll(async () => {
  await closePool();
});

const paper = (slug: string, kind = 'ICLR 2027') =>
  upsertListing({ slug, title: `Paper ${slug}`, summary: 'An abstract.', kind }).then((r) => r.listing);

const order = (token: string, listingId: string, outcome: string, stakeMicro: string, key?: string) =>
  api('POST', `/listings/${listingId}/orders`, {
    token,
    body: { outcome, stakeMicro },
    headers: key ? { 'idempotency-key': key } : undefined,
  });

/** JEV answering `probabilities` at `cost` USD, or failing with `status`. */
function stubJev(answer: { probabilities?: Record<string, number>; cost?: number; status?: number }) {
  const calls: any[] = [];
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    calls.push(JSON.parse(String(init.body)));
    if (answer.status) return new Response('down', { status: answer.status });
    return Response.json({
      answers: { decision: { probabilities: answer.probabilities } },
      usage: { cost: answer.cost },
    });
  }) as typeof fetch;
  process.env.NANOGPT_API_KEY = 'test-key';
  return calls;
}

const mainMarketOf = async (listingId: string) => db.select().from(markets).where(eq(markets.listingId, listingId));

describe('a listing’s first trade makes its market', () => {
  it('opens at the fallback without a model, records who made it, and fills within the stake', async () => {
    const p = await paper('p');
    const t = await trader('t');
    expect(await mainMarketOf(p.id)).toHaveLength(0);

    const res = await order(t.token, p.id, 'Accept', '10000000');
    expect(res.status).toBe(201);
    const fill = res.body as any;
    expect(fill.marketCreated).toBe(true);
    expect(fill.firstTrade).toBe(true);
    expect(fill.priceBefore).toBeCloseTo(0.33, 6);
    expect(BigInt(fill.costMicro)).toBeLessThanOrEqual(10_000_000n);
    expect(BigInt(fill.costMicro)).toBeGreaterThan(9_999_000n);

    const [m] = await mainMarketOf(p.id);
    expect(m.isMain).toBe(true);
    expect(m.createdBy).toBe(t.id);
    expect(m.kind).toBe('ICLR 2027');
    expect(m.id).toBe(fill.marketId);

    // The next order trades on it.
    const again = await order(t.token, p.id, 'Reject', '5000000');
    expect(again.status).toBe(201);
    expect((again.body as any).marketCreated).toBe(false);
    expect((again.body as any).marketId).toBe(m.id);
    expect(await mainMarketOf(p.id)).toHaveLength(1);
  });

  it('opens at JEV’s prices, floored, and books what it cost in real money', async () => {
    const calls = stubJev({ probabilities: { Accept: 0.9, Reject: 0.1 }, cost: 0.0000288 });
    const p = await paper('p');
    const t = await trader('t');
    const res = await order(t.token, p.id, 'Reject', '1000000');
    expect(res.status).toBe(201);
    // (1 − 2·0.05)·0.1 + 0.05
    expect((res.body as any).priceBefore).toBeCloseTo(0.14, 6);
    expect(calls).toHaveLength(1);
    expect(calls[0].state.paper).toContain('Paper p');
    expect(Object.keys(calls[0].questions.decision.criteria)).toEqual(['Accept', 'Reject']);
    const costs = await db.select().from(usdCosts);
    expect(costs.map((c) => [c.source, c.amountUsdMicro])).toEqual([['jev', 29n]]);
  });

  it('falls back when JEV fails', async () => {
    stubJev({ status: 500 });
    const p = await paper('p');
    const t = await trader('t');
    const res = await order(t.token, p.id, 'Accept', '1000000');
    expect(res.status).toBe(201);
    expect((res.body as any).priceBefore).toBeCloseTo(0.33, 6);
  });

  it('makes one market when first trades race', async () => {
    const p = await paper('p');
    const traders = await Promise.all(['a', 'b', 'c', 'd'].map((h) => trader(h)));
    const results = await Promise.all(traders.map((t) => order(t.token, p.id, 'Accept', '2000000')));
    expect(results.map((r) => [r.status, (r.body as any).error?.code])).toEqual([
      [201, undefined],
      [201, undefined],
      [201, undefined],
      [201, undefined],
    ]);
    expect(results.filter((r) => (r.body as any).marketCreated)).toHaveLength(1);
    expect(await mainMarketOf(p.id)).toHaveLength(1);
    expect(new Set(results.map((r) => (r.body as any).marketId)).size).toBe(1);
  });

  it('replays a retried key, and refuses one reused for another order', async () => {
    const p = await paper('p');
    const t = await trader('t');
    const first = await order(t.token, p.id, 'Accept', '3000000', 'k1');
    const retry = await order(t.token, p.id, 'Accept', '3000000', 'k1');
    expect(retry.status).toBe(201);
    expect((retry.body as any).replayed).toBe(true);
    expect((retry.body as any).orderId).toBe((first.body as any).orderId);
    const other = await order(t.token, p.id, 'Reject', '3000000', 'k1');
    expect(other.status).toBe(409);
    expect((other.body as any).error.code).toBe('idempotency_key_reused');
  });

  it('makes nothing for an order that could not fill', async () => {
    const p = await paper('p');
    const t = await trader('t');
    const unverified = await trader('u', ['read', 'trade'], { verified: false });

    const broke = await order(t.token, p.id, 'Accept', (STARTING_MICRO + 1n).toString());
    expect(broke.status).toBe(409);
    expect((broke.body as any).error.code).toBe('insufficient_balance');
    expect((await order(unverified.token, p.id, 'Accept', '1000000')).status).toBe(403);
    expect(await mainMarketOf(p.id)).toHaveLength(0);

    const elsewhere = await paper('q', 'Somewhere 2030');
    const none = await order(t.token, elsewhere.id, 'Accept', '1000000');
    expect(none.status).toBe(409);
    expect(await mainMarketOf(elsewhere.id)).toHaveLength(0);

    expect((await order(t.token, p.id, 'Maybe', '1000000')).status).toBe(404);
  });

  it('is refused once the kind’s markets have closed', async () => {
    vi.setSystemTime(new Date('2026-12-20T00:00:00Z'));
    const p = await paper('p');
    const t = await trader('t');
    const res = await order(t.token, p.id, 'Accept', '1000000');
    expect(res.status).toBe(409);
    expect((res.body as any).error.code).toBe('market_closed');
  });
});

describe('the home list before and after a first trade', () => {
  it('lists an untraded paper without a market, after every paper that has one', async () => {
    const untraded = await paper('untraded');
    const traded = await paper('traded');
    const t = await trader('t');
    await order(t.token, traded.id, 'Accept', '1000000');

    for (const sort of ['closing', 'likelihood', 'volume', 'activity', 'newest'] as const) {
      const { rows, total } = await browseListings({ kind: 'ICLR 2027', sort });
      expect(total).toBe(2);
      expect(rows.map((r) => [r.listing?.slug, r.main !== null, r.marketCount])).toEqual([
        ['traded', true, 1],
        ['untraded', false, 0],
      ]);
    }
    expect((await browseListings({ kind: 'ICLR 2027', sort: 'closing', traded: true })).total).toBe(1);
    // Untraded counts as open, never as closed or settled.
    expect((await browseListings({ kind: 'ICLR 2027', sort: 'closing', status: 'settled' })).total).toBe(0);
    expect((await browseListings({ kind: 'ICLR 2027', sort: 'closing', q: 'untraded' })).rows[0].listing?.id).toBe(
      untraded.id,
    );
    expect(await marketKinds()).toEqual([
      { kind: 'ICLR 2027', count: 2 },
      { kind: 'binary', count: 1 },
    ]);
  });
});

describe('related papers before and after a bet', () => {
  it('gives out the first 3 until the paper has a bet, then all of them', async () => {
    const p = await paper('p');
    const others = ['r1', 'r2', 'r3', 'r4', 'r5'];
    for (const slug of others) await paper(slug);
    await setRelated(
      p,
      others.map((slug, i) => ({ slug, score: 1 - i / 10 })),
    );
    const read = async () => (await api('GET', `/listings/${p.id}/related`)).body as any;

    const before = await read();
    expect(before.related.map((r: any) => r.slug)).toEqual(['r1', 'r2', 'r3']);
    expect(before.hidden).toBe(2);

    const t = await trader('t');
    expect((await order(t.token, p.id, 'Accept', '1000000')).status).toBe(201);
    const after = await read();
    expect(after.related.map((r: any) => r.slug)).toEqual(others);
    expect(after.hidden).toBe(0);
  });
});

describe('opening a market at JEV’s price, without a trade', () => {
  const open = (token: string | undefined, listingId: string) =>
    api('POST', `/listings/${listingId}/market`, { token });

  it('opens it at JEV’s price for a trading-eligible account, once', async () => {
    stubJev({ probabilities: { Accept: 0.5, Reject: 0.5 }, cost: 0.00003 });
    const p = await paper('p');
    const t = await trader('t');

    const first = await open(t.token, p.id);
    expect(first.status).toBe(201);
    const body = first.body as any;
    expect(body.created).toBe(true);
    expect(body.market.outcomes.map((o: any) => o.price)).toEqual([0.5, 0.5]);
    expect(body.market.orderCount).toBe(0);
    const [m] = await mainMarketOf(p.id);
    expect(m.createdBy).toBe(t.id);

    const again = await open(t.token, p.id);
    expect(again.status).toBe(200);
    expect((again.body as any).created).toBe(false);
    expect((again.body as any).market.id).toBe(m.id);
    expect(await mainMarketOf(p.id)).toHaveLength(1);
  });

  it('follows the paper for whoever opened it, once, and nobody for a visitor', async () => {
    const [p, q] = await Promise.all([paper('p'), paper('q')]);
    const t = await trader('t');
    const other = await trader('o');

    expect((await open(t.token, p.id)).status).toBe(201);
    expect(await followedListingIds(t.id)).toEqual(new Set([p.id]));

    // Opening it again, or someone else asking for it, follows nothing: an unfollow stays.
    await unfollow(t.id, p.id);
    expect((await open(t.token, p.id)).status).toBe(200);
    expect((await open(other.token, p.id)).status).toBe(200);
    expect(await followedListingIds(t.id)).toEqual(new Set());
    expect(await followedListingIds(other.id)).toEqual(new Set());

    expect((await open(undefined, q.id)).status).toBe(201);
    expect(await followedListingIds(t.id)).toEqual(new Set());
  });

  it('backfills a follow for every account that opened a paper’s market, and nobody else', async () => {
    const [p, q, r] = await Promise.all([paper('p'), paper('q'), paper('r')]);
    const t = await trader('t');
    const other = await trader('o');
    await open(t.token, p.id);
    await open(t.token, q.id);
    await open(undefined, r.id);
    await order(other.token, r.id, 'Accept', '1000000');
    // As before opening followed: t follows only q.
    await unfollow(t.id, p.id);

    expect(await followOpenedListings({ apply: false })).toBe(1);
    expect(await followedListingIds(t.id)).toEqual(new Set([q.id]));
    expect(await followOpenedListings({ apply: true })).toBe(1);
    expect(await followedListingIds(t.id)).toEqual(new Set([p.id, q.id]));
    expect(await followedListingIds(other.id)).toEqual(new Set());
    expect(await followOpenedListings({ apply: true })).toBe(0);
  });

  it('refuses an unverified account, a read-only token and a bad one, and makes nothing', async () => {
    const p = await paper('p');
    const unverified = await trader('u', ['read', 'trade'], { verified: false });
    const reader = await trader('r', ['read']);
    expect((await open(unverified.token, p.id)).status).toBe(403);
    expect((await open(reader.token, p.id)).status).toBe(403);
    expect((await open('pm_live_not-a-key', p.id)).status).toBe(401);
    expect(await mainMarketOf(p.id)).toHaveLength(0);
  });

  it('never opens one for a bot, either way, but lets it trade on one a person opened', async () => {
    const calls = stubJev({ probabilities: { Accept: 0.5, Reject: 0.5 } });
    const p = await paper('p');
    const bot = await trader('b', ['read', 'trade'], { isBot: true });

    const opened = await open(bot.token, p.id);
    expect(opened.status).toBe(403);
    expect((opened.body as any).error.code).toBe('bots_cannot_open_markets');
    const bought = await order(bot.token, p.id, 'Accept', '1000000');
    expect(bought.status).toBe(403);
    expect((bought.body as any).error.code).toBe('bots_cannot_open_markets');
    expect(await mainMarketOf(p.id)).toHaveLength(0);
    expect(calls).toHaveLength(0);

    const t = await trader('t');
    expect((await open(t.token, p.id)).status).toBe(201);
    expect((await open(bot.token, p.id)).status).toBe(200);
    const filled = await order(bot.token, p.id, 'Accept', '1000000');
    expect(filled.status).toBe(201);
    expect((filled.body as any).marketCreated).toBe(false);
  });

  it('opens it for a visitor with no credential, made by nobody, from the visitors’ shared budget', async () => {
    stubJev({ probabilities: { Accept: 0.3, Reject: 0.7 } });
    const [a, b] = await Promise.all([paper('a'), paper('b')]);

    const first = await open(undefined, a.id);
    expect(first.status).toBe(201);
    expect((first.body as any).market.outcomes[0].price).toBeCloseTo(0.32);
    const [m] = await mainMarketOf(a.id);
    expect(m.createdBy).toBeNull();

    // Out of budget: an existing market is still free, a new one is refused.
    for (let i = 0; i < ANONYMOUS_OPEN_BUDGET.burst; i++) await consume('market-open:anonymous', ANONYMOUS_OPEN_BUDGET);
    expect((await open(undefined, a.id)).status).toBe(200);
    expect((await open(undefined, b.id)).status).toBe(429);
    expect(await mainMarketOf(b.id)).toHaveLength(0);
  });

  it('counts markets a first order opens against the same hourly budget', async () => {
    const [a, b, c] = await Promise.all([paper('a'), paper('b'), paper('c')]);
    const t = await trader('opener');
    expect((await order(t.token, a.id, 'Accept', '1000000')).status).toBe(201);
    // The first open spent one; spend the rest.
    for (let i = 1; i < OPEN_BUDGET.burst; i++) await consume(`market-open:${t.id}`, OPEN_BUDGET);
    expect((await order(t.token, b.id, 'Accept', '1000000')).status).toBe(429);
    expect((await open(t.token, c.id)).status).toBe(429);
    expect(await mainMarketOf(b.id)).toHaveLength(0);
    // Trading on a market that exists costs nothing.
    expect((await order(t.token, a.id, 'Accept', '1000000')).status).toBe(201);
  });

  it('lists an opened but untraded paper with no price, after the traded ones', async () => {
    const opened = await paper('opened');
    const traded = await paper('traded');
    const t = await trader('t');
    await open(t.token, opened.id);
    await order(t.token, traded.id, 'Accept', '1000000');
    for (const sort of ['likelihood', 'newest', 'volume'] as const) {
      const { rows } = await browseListings({ kind: 'ICLR 2027', sort });
      expect(rows.map((r) => [r.listing?.slug, r.main?.orderCount])).toEqual([
        ['traded', 1],
        ['opened', 0],
      ]);
    }
  });
});

describe('JEV reads the full text when it is supplied', () => {
  const admin = () => trader('admin', ['admin']);

  it('stores it from PUT /listings/{id}/text, keeps it off the listing, and sends it to JEV instead of the abstract', async () => {
    const a = await admin();
    const p = await upsertListing({ slug: 'p', title: 'Paper p', summary: 'Only the abstract.', kind: 'ICLR 2027' });
    const put = (text: string | null) =>
      api('PUT', `/listings/${p.listing.id}/text`, { token: a.token, body: { text } });
    const set = await put('1 Introduction. The whole paper.');
    expect(set.status).toBe(200);
    expect((set.body as any).chars).toBe(32);
    const t = await trader('t');
    expect((await put('nope')).status).toBe(200);
    expect((await api('PUT', `/listings/${p.listing.id}/text`, { token: t.token, body: { text: 'x' } })).status).toBe(
      403,
    );
    await put('1 Introduction. The whole paper.');
    // Re-posting the listing keeps it: the text is not one of its fields.
    expect(
      (
        await api('POST', '/listings', {
          token: a.token,
          body: { slug: 'p', title: 'Paper p', summary: 'Only the abstract.', kind: 'ICLR 2027' },
        })
      ).status,
    ).toBe(200);
    expect(JSON.stringify((await api('GET', '/listings/p')).body)).not.toContain('whole paper');

    const calls = stubJev({ probabilities: { Accept: 0.5, Reject: 0.5 } });
    expect((await api('POST', `/listings/${p.listing.id}/market`, { token: t.token })).status).toBe(201);
    expect(calls[0].state.paper).toContain('Paper:\n1 Introduction. The whole paper.');
    expect(calls[0].state.paper).not.toContain('Only the abstract.');

    expect((await put(null)).status).toBe(200);
    expect(await db.select().from(listingTexts)).toHaveLength(0);
  });

  it('serves it to any signed-in reader, by id or slug, and to nobody anonymous', async () => {
    const a = await admin();
    const p = await upsertListing({ slug: 'p', title: 'Paper p', summary: 'An abstract.', kind: 'ICLR 2027' });
    const reader = await trader('r', ['read']);
    const bot = await trader('b', ['read', 'trade'], { isBot: true });
    const get = (ref: string, token?: string) => api('GET', `/listings/${ref}/text`, { token });

    // None supplied yet: a 200 saying so, not a 404, which means no listing.
    expect((await get(p.listing.id, reader.token)).body).toEqual({
      listingId: p.listing.id,
      text: null,
      chars: 0,
      source: null,
    });

    await api('PUT', `/listings/${p.listing.id}/text`, {
      token: a.token,
      body: { text: '1 Introduction. The whole paper.', source: 'openreview' },
    });
    for (const res of [await get(p.listing.id, reader.token), await get('p', bot.token)]) {
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        listingId: p.listing.id,
        text: '1 Introduction. The whole paper.',
        chars: 32,
        source: 'openreview',
      });
    }

    expect((await get(p.listing.id)).status).toBe(401);
    expect((await get(p.listing.id, 'pm_live_not-a-key')).status).toBe(401);
    expect((await get('no-such-paper', reader.token)).status).toBe(404);
  });

  it('keeps the source with the text, replaced whole and cleared with it', async () => {
    const a = await admin();
    const p = await upsertListing({ slug: 'p', title: 'Paper p', kind: 'ICLR 2027' });
    const put = (body: object) => api('PUT', `/listings/${p.listing.id}/text`, { token: a.token, body });
    const source = async () => (await db.select().from(listingTexts))[0]?.source;

    expect((await put({ text: 'From the preprint.', source: 'arxiv' })).status).toBe(200);
    expect(await source()).toBe('arxiv');
    // Sent again without one, the text has none: the call replaces both.
    await put({ text: 'From the submission.' });
    expect(await source()).toBeNull();
    await put({ text: 'From the submission.', source: 'openreview' });
    expect(await source()).toBe('openreview');
    expect((await put({ text: 'x', source: '' })).status).toBe(400);
    expect((await put({ text: 'x', source: 'y'.repeat(101) })).status).toBe(400);
    await put({ text: null, source: 'openreview' });
    expect(await db.select().from(listingTexts)).toHaveLength(0);
  });

  it('asks again with the abstract when JEV refuses the full text', async () => {
    const { listing } = await upsertListing({
      slug: 'p',
      title: 'Paper p',
      summary: 'The abstract.',
      kind: 'ICLR 2027',
    });
    await setText(listing, 'x');
    const calls: any[] = [];
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      calls.push(body);
      if (body.state.paper.includes('Paper:')) return new Response('too long', { status: 400 });
      return Response.json({ answers: { decision: { probabilities: { Accept: 0.9, Reject: 0.1 } } } });
    }) as typeof fetch;
    process.env.NANOGPT_API_KEY = 'test-key';
    const t = await trader('t');
    const res = await api('POST', `/listings/${listing.id}/market`, { token: t.token });
    expect(res.status).toBe(201);
    expect(calls).toHaveLength(2);
    expect(calls[1].state.paper).toContain('Abstract: The abstract.');
    expect((res.body as any).market.outcomes[0].price).toBeCloseTo(0.86, 6);
  });
});
