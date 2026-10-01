/* eslint-disable @typescript-eslint/no-explicit-any -- response bodies are checked field by field */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { markets } from '@/db/schema';
import { marketHeadline } from '@/lib/headline';
import { createMarket } from '@/server/engine';
import { upsertListing } from '@/server/listings';
import { browseListings, marketKinds, sparklines } from '@/server/views';
import { api, trader } from './api-client';
import { closePool, resetDatabase, seedMarket, STARTING_MICRO, type Fixture } from './helpers';

const db = getDb();
let fx: Fixture;
let admin: { token: string };

beforeEach(async () => {
  await resetDatabase();
  process.env.API_RATE_LIMIT_BURST = '1000';
  process.env.API_RATE_LIMIT_PER_SECOND = '1000';
  process.env.STARTING_BALANCE_MICRO = STARTING_MICRO.toString();
  fx = await seedMarket(0, 10);
  admin = await trader('admin', ['admin']);
}, 60_000);

afterAll(async () => {
  await closePool();
});

const LISTING = {
  slug: 'subject-one',
  title: 'An opaque subject',
  summary: 'Some text the client supplied.',
  authors: ['A. Person', 'B. Person'],
  links: [
    { label: 'PDF', url: 'https://example.org/one.pdf' },
    { label: 'Page', url: 'http://example.org/one' },
  ],
  kind: 'ICLR 2027',
};

function market(slug: string, extra: Record<string, unknown> = {}) {
  return api('POST', '/markets', {
    token: admin.token,
    body: {
      slug,
      question: `${slug}?`,
      outcomes: ['YES', 'NO'],
      closesAt: new Date(Date.now() + 86_400_000).toISOString(),
      expectedTraders: 10,
      kind: 'ICLR 2027',
      ...extra,
    },
  });
}

describe('POST /listings', () => {
  it('creates, then replaces by slug', async () => {
    const created = await api('POST', '/listings', { token: admin.token, body: LISTING });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ created: true, listing: { ...LISTING, markets: [] } });

    const replaced = await api('POST', '/listings', {
      token: admin.token,
      body: { slug: LISTING.slug, title: 'Renamed', authors: ['C. Person'] },
    });
    expect(replaced.status).toBe(200);
    expect(replaced.body.created).toBe(false);
    // Same row, every field replaced: the ones left out are cleared.
    expect(replaced.body.listing).toMatchObject({
      id: created.body.listing.id,
      title: 'Renamed',
      authors: ['C. Person'],
      summary: null,
      links: [],
      kind: null,
    });
  });

  it('needs the admin scope', async () => {
    const t = await trader('t');
    expect((await api('POST', '/listings', { body: LISTING })).status).toBe(401);
    expect((await api('POST', '/listings', { token: t.token, body: LISTING })).status).toBe(403);
  });

  it('refuses non-http(s) links, a bad slug and an empty title', async () => {
    for (const body of [
      { ...LISTING, links: [{ label: 'x', url: 'javascript:alert(1)' }] },
      { ...LISTING, links: [{ label: 'x', url: 'ftp://example.org/a' }] },
      { ...LISTING, slug: 'Not A Slug' },
      { ...LISTING, slug: '00000000-0000-4000-8000-000000000000' },
      { ...LISTING, title: '   ' },
    ]) {
      const res = await api('POST', '/listings', { token: admin.token, body });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('validation_error');
    }
  });
});

describe('markets in a listing', () => {
  it('attach by listingSlug and come back ordered by rank, by id or slug', async () => {
    const listing = (await api('POST', '/listings', { token: admin.token, body: LISTING })).body.listing;
    const oral = await market('subject-one-oral', { listingSlug: LISTING.slug, listingRank: 1 });
    expect(oral.status).toBe(201);
    expect(oral.body.market).toMatchObject({ listingId: listing.id, listingRank: 1 });
    const main = await market('subject-one-accept', { listingSlug: LISTING.slug });
    expect(main.body.market).toMatchObject({ listingId: listing.id, listingRank: 0 });

    for (const ref of [listing.id, LISTING.slug]) {
      const res = await api('GET', `/listings/${ref}`);
      expect(res.status).toBe(200);
      expect(res.body.markets.map((m: any) => m.slug)).toEqual(['subject-one-accept', 'subject-one-oral']);
    }

    // A market outside any listing says so.
    expect((await api('GET', `/markets/${fx.marketId}`)).body).toMatchObject({ listingId: null, listingRank: 0 });
  });

  it('refuses an unknown listing, and a rank without one', async () => {
    const unknown = await market('orphan', { listingSlug: 'no-such-listing' });
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe('not_found');
    expect(await db.select().from(markets).where(eq(markets.slug, 'orphan'))).toEqual([]);

    const rankOnly = await market('rank-only', { listingRank: 2 });
    expect(rankOnly.status).toBe(400);
    await upsertListing(LISTING);
    expect((await market('negative', { listingSlug: LISTING.slug, listingRank: -1 })).status).toBe(400);
  });

  it('404s an unknown listing on read', async () => {
    const res = await api('GET', '/listings/nope');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
  });
});

describe('GET /listings', () => {
  it('pages newest first without repeats, and filters by kind', async () => {
    for (const [slug, kind] of [
      ['l-a', 'x'],
      ['l-b', 'y'],
      ['l-c', 'x'],
    ]) {
      await upsertListing({ slug, title: slug, kind });
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const res: any = await api('GET', `/listings?limit=1${cursor ? `&cursor=${cursor}` : ''}`);
      expect(res.status).toBe(200);
      seen.push(...res.body.listings.map((l: any) => l.slug));
      cursor = res.body.nextCursor;
    } while (cursor);
    expect(seen).toEqual(['l-c', 'l-b', 'l-a']);
    expect((await api('GET', '/listings?kind=x')).body.listings.map((l: any) => l.slug)).toEqual(['l-c', 'l-a']);
  });
});

describe('citations (#38)', () => {
  const post = (body: Record<string, unknown>) => api('POST', '/listings', { token: admin.token, body });
  const citations = (ref: string) => api('GET', `/listings/${ref}/citations`);

  it('keeps the bibliography in order, matching slugs to listings when read', async () => {
    await post({ slug: 'cited', title: 'Cited paper', authors: ['A. Cited'] });
    expect((await market('cited-accept', { listingSlug: 'cited' })).status).toBe(201);
    const res = await post({
      slug: 'citing',
      title: 'Citing paper',
      references: [
        { title: 'Off the site', authors: ['X. Y.'], year: 1986, url: 'https://example.org/x' },
        { title: 'Cited paper', slug: 'cited' },
        { title: 'Not listed yet', slug: 'later' },
      ],
    });
    expect(res.status).toBe(201);

    const first = await citations('citing');
    expect(first.status).toBe(200);
    expect(first.body.references).toMatchObject([
      {
        title: 'Off the site',
        authors: ['X. Y.'],
        year: 1986,
        url: 'https://example.org/x',
        slug: null,
        listing: null,
      },
      { title: 'Cited paper', slug: 'cited', listing: { slug: 'cited', market: { slug: 'cited-accept' } } },
      { title: 'Not listed yet', slug: 'later', listing: null },
    ]);

    // Listed afterwards, it links up by itself, with no market yet.
    await post({ slug: 'later', title: 'Later paper' });
    expect((await citations('citing')).body.references[2].listing).toMatchObject({ slug: 'later', market: null });
  });

  it('lists who cites a listing once each, never itself', async () => {
    await post({ slug: 'a', title: 'A' });
    await post({
      slug: 'b',
      title: 'B',
      references: [
        { title: 'A', slug: 'a' },
        { title: 'A again', slug: 'a' },
      ],
    });
    await post({ slug: 'c', title: 'C', references: [{ title: 'A', slug: 'a' }] });
    await post({ slug: 'self', title: 'Self', references: [{ title: 'Self', slug: 'self' }] });

    const a = await citations('a');
    expect(a.body.citedBy.map((l: any) => l.slug)).toEqual(['c', 'b']);
    expect(a.body.citedByTotal).toBe(2);

    const self = await citations('self');
    expect(self.body.citedBy).toEqual([]);
    expect(self.body.references).toMatchObject([{ slug: 'self', listing: null }]);
  });

  it('replaces the bibliography whole, and clears it when left out', async () => {
    await post({ slug: 'a', title: 'A' });
    await post({ slug: 'b', title: 'B', references: [{ title: 'one' }, { title: 'A', slug: 'a' }] });
    await post({ slug: 'b', title: 'B', references: [{ title: 'two' }] });
    expect((await citations('b')).body.references.map((r: any) => r.title)).toEqual(['two']);
    expect((await citations('a')).body.citedBy).toEqual([]);

    await post({ slug: 'b', title: 'B' });
    expect((await citations('b')).body.references).toEqual([]);
  });

  it('refuses a bad reference, and 404s an unknown listing', async () => {
    for (const references of [
      [{ title: 'x', url: 'javascript:alert(1)' }],
      [{ title: '  ' }],
      [{ title: 'x', slug: 'Not A Slug' }],
    ]) {
      const res = await post({ slug: 'bad', title: 'Bad', references });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('validation_error');
    }
    expect((await citations('nope')).status).toBe(404);
  });
});

describe('browsing listings', () => {
  it('shows one row per listing, read from its main market, plus unlisted markets', async () => {
    const { listing } = await upsertListing({ slug: 'p', title: 'P' });
    const opts = {
      outcomes: ['YES', 'NO'],
      startingBalanceMicro: STARTING_MICRO,
      expectedTraders: 10,
      kind: 'binary',
      listingId: listing.id,
    };
    const second = await createMarket({
      ...opts,
      slug: 'p-oral',
      question: 'oral?',
      listingRank: 1,
      closesAt: new Date(Date.now() + 2 * 86_400_000),
    });
    const main = await createMarket({
      ...opts,
      slug: 'p-accept',
      question: 'accept?',
      listingRank: 0,
      closesAt: new Date(Date.now() + 3 * 86_400_000),
    });

    const t = await trader('t');
    const buy = (marketId: string, outcomeId: string) =>
      api('POST', `/markets/${marketId}/orders`, {
        token: t.token,
        body: { outcomeId, sharesMicro: '10000000', maxCostMicro: '1000000000' },
      });
    await buy(main.marketId, main.outcomeIds[0]);
    await buy(second.marketId, second.outcomeIds[1]);

    const { rows } = await browseListings({ kind: null, sort: 'closing' });
    expect(rows.map((r) => [r.market.slug, r.listing?.slug ?? null, r.marketCount])).toEqual([
      ['concurrency', null, 1],
      ['p-accept', 'p', 2],
    ]);
    const row = rows[1];
    // Volume and fills over the whole listing; the headline from the main market.
    expect(row.totalOrderCount).toBe(2);
    expect(row.totalVolumeMicro).toBeGreaterThan(row.volumeMicro);
    expect(row.outcomes[0].price).toBeGreaterThan(0.5);
    // The sparkline is the main market's.
    expect((await sparklines(rows)).get(main.marketId)).toHaveLength(2);

    // A listing counts once in its main market's kind.
    expect(await marketKinds()).toEqual([{ kind: 'binary', count: 2 }]);
  });

  it('sorts by likelihood: the headline, highest first, void last', async () => {
    const opts = {
      startingBalanceMicro: STARTING_MICRO,
      expectedTraders: 10,
      kind: 'lk',
      closesAt: new Date(Date.now() + 86_400_000),
    };
    const make = (slug: string, outcomes = ['YES', 'NO']) =>
      createMarket({ ...opts, slug, question: `${slug}?`, outcomes });
    const low = await make('low');
    const high = await make('high');
    await make('mid');
    // Three outcomes open at a headline of 1 − 1/3.
    const multi = await make('multi', ['A', 'B', 'C']);
    const gone = await make('gone', ['A', 'B', 'C']);

    const t = await trader('t');
    const buy = (marketId: string, outcomeId: string, units: number) =>
      api('POST', `/markets/${marketId}/orders`, {
        token: t.token,
        body: { outcomeId, sharesMicro: String(units * 1_000_000), maxCostMicro: '1000000000' },
      });
    await buy(low.marketId, low.outcomeIds[1], 20);
    await buy(high.marketId, high.outcomeIds[0], 30);
    await buy(multi.marketId, multi.outcomeIds[0], 50);

    // There is no void path in the engine yet; the status is all the sort reads.
    await db.update(markets).set({ status: 'void' }).where(eq(markets.id, gone.marketId));

    const { rows } = await browseListings({ kind: 'lk', sort: 'likelihood', status: 'all' });
    expect(rows.map((r) => r.market.slug)).toEqual(['multi', 'high', 'mid', 'low', 'gone']);
    expect(rows[2].outcomes[0].price).toBeCloseTo(0.5);
    // The SQL headline is the same number `lib/headline.ts` computes.
    const m = rows[0];
    expect(1 - m.outcomes[2].price).toBeGreaterThan(2 / 3);
    expect(marketHeadline({ ...m.market, outcomes: m.outcomes })).toBeCloseTo(1 - m.outcomes[2].price, 12);
  });
});
