/* eslint-disable @typescript-eslint/no-explicit-any -- response bodies are checked field by field */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { markets } from '@/db/schema';
import { marketHeadline } from '@/lib/headline';
import { MINIMAP_NEAREST } from '@/lib/map';
import { createMarket } from '@/server/engine';
import { upsertListing } from '@/server/listings';
import {
  browseListings,
  listingMinimap,
  listingRelatedTo,
  marketKinds,
  resolveListing,
  sparklines,
} from '@/server/views';
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
  tldr: 'One line of it.',
  authors: ['A. Person', 'B. Person'],
  authorIds: ['~A_Person1', '~B_Person1'],
  keywords: ['first topic', 'second topic'],
  primaryArea: 'some area',
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
      authorIds: [],
      keywords: [],
      primaryArea: null,
      summary: null,
      tldr: null,
      links: [],
      kind: null,
    });
  });

  it('needs the admin scope', async () => {
    const t = await trader('t');
    expect((await api('POST', '/listings', { body: LISTING })).status).toBe(401);
    expect((await api('POST', '/listings', { token: t.token, body: LISTING })).status).toBe(403);
  });

  it('refuses non-http(s) links, a bad slug, an empty title and ids that do not match the authors', async () => {
    for (const body of [
      { ...LISTING, links: [{ label: 'x', url: 'javascript:alert(1)' }] },
      { ...LISTING, links: [{ label: 'x', url: 'ftp://example.org/a' }] },
      { ...LISTING, slug: 'Not A Slug' },
      { ...LISTING, slug: '00000000-0000-4000-8000-000000000000' },
      { ...LISTING, title: '   ' },
      { ...LISTING, authorIds: ['~A_Person1'] },
      { ...LISTING, authors: undefined },
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
        { title: 'Off the site', authors: ['X. Y.'], year: 1986, venue: 'Nature', url: 'https://example.org/x' },
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
        venue: 'Nature',
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

describe('related listings', () => {
  const post = (body: Record<string, unknown>) => api('POST', '/listings', { token: admin.token, body });
  const put = (ref: string, related: unknown, token = admin.token) =>
    api('PUT', `/listings/${ref}/related`, { token, body: { related } });
  const related = (ref: string) => api('GET', `/listings/${ref}/related`);

  it('keeps the supplied order, matches slugs when read and skips unlisted ones', async () => {
    for (const slug of ['a', 'b', 'c']) await post({ slug, title: `Paper ${slug}` });
    expect((await market('c-accept', { listingSlug: 'c' })).status).toBe(201);

    const res = await put('a', [
      { slug: 'c', score: 0.9 },
      { slug: 'not-yet', score: 0.8 },
      { slug: 'a', score: 0.7 },
      { slug: 'b', score: 0.6 },
      { slug: 'c', score: 0.5 },
    ]);
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(3);

    const got = await related('a');
    expect(got.body.related.map((r: any) => r.slug)).toEqual(['c', 'b']);
    expect(got.body.related[0].market).not.toBeNull();
    expect(got.body.related[1].market).toBeNull();

    await post({ slug: 'not-yet', title: 'Later' });
    expect((await related('a')).body.related.map((r: any) => r.slug)).toEqual(['c', 'not-yet', 'b']);
  });

  it('is replaced whole, survives a listing upsert and is directional', async () => {
    for (const slug of ['a', 'b']) await post({ slug, title: slug });
    await put('a', [{ slug: 'b', score: 1 }]);
    await post({ slug: 'a', title: 'a, retitled' });
    expect((await related('a')).body.related).toHaveLength(1);
    expect((await related('b')).body.related).toEqual([]);
    await put('a', []);
    expect((await related('a')).body.related).toEqual([]);
  });

  it('needs the admin scope and an existing listing', async () => {
    await post({ slug: 'a', title: 'a' });
    const reader = await trader('reader', ['read']);
    expect((await put('a', [], reader.token)).status).toBe(403);
    expect((await put('nope', [])).status).toBe(404);
    expect((await related('nope')).status).toBe(404);
  });
});

describe('the paper map', () => {
  const post = (body: Record<string, unknown>) => api('POST', '/listings', { token: admin.token, body });
  const put = (body: unknown, token = admin.token) => api('PUT', '/map', { token, body });
  const getMap = () => api('GET', '/map');

  it('matches slugs when read, skips unlisted ones and carries the main market’s headline', async () => {
    for (const slug of ['a', 'b']) await post({ slug, title: `Paper ${slug}`, primaryArea: 'area' });
    expect((await market('a-accept', { listingSlug: 'a' })).status).toBe(201);

    const res = await put({
      points: [
        { slug: 'a', x: 1, y: 2, region: 0, cluster: 3 },
        { slug: 'not-yet', x: 0, y: 0 },
        { slug: 'b', x: -1, y: 5, region: 1, cluster: null },
        { slug: 'a', x: 9, y: 9 },
      ],
      regions: [
        { number: 0, label: 'first region' },
        { number: 1, label: 'second region' },
      ],
      clusters: [{ number: 3, label: 'a cluster' }],
    });
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(3);

    const got = await getMap();
    expect(got.status).toBe(200);
    expect(got.headers.get('cache-control')).toBe('public, max-age=300');
    expect(got.body.points.map((p: any) => [p.slug, p.x, p.y, p.region, p.cluster])).toEqual([
      ['a', 1, 2, 0, 3],
      ['b', -1, 5, 1, null],
    ]);
    expect(got.body.points[0].title).toBe('Paper a');
    expect(got.body.points[0].primaryArea).toBe('area');
    expect(got.body.points[0].headline).toBeCloseTo(0.5);
    expect(got.body.points[1].headline).toBeNull();
    expect(got.body.regions).toEqual([
      { number: 0, label: 'first region' },
      { number: 1, label: 'second region' },
    ]);
    expect(got.body.clusters).toEqual([{ number: 3, label: 'a cluster' }]);

    await post({ slug: 'not-yet', title: 'Later' });
    expect((await getMap()).body.points.map((p: any) => p.slug)).toEqual(['a', 'b', 'not-yet']);
  });

  it('is replaced whole, and empty clears it', async () => {
    for (const slug of ['a', 'b']) await post({ slug, title: slug });
    await put({ points: [{ slug: 'a', x: 0, y: 0 }], regions: [{ number: 0, label: 'old' }] });
    await put({ points: [{ slug: 'b', x: 1, y: 1 }] });
    const got = await getMap();
    expect(got.body.points.map((p: any) => p.slug)).toEqual(['b']);
    expect(got.body.regions).toEqual([]);
    await put({ points: [] });
    expect((await getMap()).body.points).toEqual([]);
  });

  it('needs the admin scope to write and refuses a non-finite coordinate', async () => {
    const reader = await trader('reader', ['read']);
    expect((await put({ points: [] }, reader.token)).status).toBe(403);
    expect((await put({ points: [{ slug: 'a', x: 'far', y: 0 }] })).status).toBe(400);
  });

  it('refuses vectors of different lengths', async () => {
    const points = [
      { slug: 'a', x: 0, y: 0, vector: [1, 2, 3] },
      { slug: 'b', x: 1, y: 1, vector: [1, 2] },
    ];
    expect((await put({ points })).status).toBe(400);
    expect((await put({ points: [points[0], { ...points[1], vector: null }] })).status).toBe(200);
  });
});

describe('a paper’s minimap', () => {
  const post = (body: Record<string, unknown>) => api('POST', '/listings', { token: admin.token, body });
  const putRelated = (ref: string, slugs: string[]) =>
    api('PUT', `/listings/${ref}/related`, {
      token: admin.token,
      body: { related: slugs.map((slug) => ({ slug, score: 1 })) },
    });
  const putMap = (points: { slug: string; x: number; y: number; cluster?: number; vector?: number[] }[]) =>
    api('PUT', '/map', { token: admin.token, body: { points, clusters: [{ number: 1, label: 'near' }] } });
  const minimap = async (slug: string) => {
    const listing = await resolveListing(slug);
    return listingMinimap(listing, await listingRelatedTo(listing));
  };

  it('is null off the map', async () => {
    await post({ slug: 'c', title: 'c' });
    expect(await minimap('c')).toBeNull();
  });

  it('takes in the nearest papers and the related ones wherever they lie, with the related pairs among them', async () => {
    // Papers at distance 1, 2, … from the paper: only the nearest MINIMAP_NEAREST belong.
    const line = Array.from({ length: MINIMAP_NEAREST + 10 }, (_, k) => ({
      slug: `n${k}`,
      x: k + 1,
      y: 0,
      cluster: 1,
    }));
    for (const slug of ['c', 'far', 'theirs', 'unmapped', ...line.map((p) => p.slug)])
      await post({ slug, title: slug });
    await putMap([
      { slug: 'c', x: 0, y: 0, cluster: 1 },
      { slug: 'far', x: 1000, y: 0 },
      { slug: 'theirs', x: 0, y: 2000 },
      ...line,
    ]);
    await putRelated('c', ['far', 'unmapped', 'n0']);
    // A related paper's own related papers stay out unless they are near anyway.
    await putRelated('far', ['theirs', 'c', 'n1']);

    const m = (await minimap('c'))!;
    expect(m.points[m.self].slug).toBe('c');
    expect(m.related.map((i) => m.points[i].slug)).toEqual(['far', 'n0']);
    expect(m.relatedElsewhere).toBe(1);
    const slugs = m.points.map((p) => p.slug);
    expect(slugs).toContain('far');
    expect(slugs).not.toContain('theirs');
    expect(slugs.filter((s) => s.startsWith('n'))).toHaveLength(MINIMAP_NEAREST);
    expect(slugs).not.toContain(`n${MINIMAP_NEAREST}`);
    expect(m.clusters).toEqual([{ number: 1, label: 'near' }]);
    const pair = ([a, b]: [number, number]) => `${m.points[a].slug}>${m.points[b].slug}`;
    expect(m.edges.map(pair).sort()).toEqual(['c>far', 'c>n0', 'far>c', 'far>n1']);
    // No vectors were supplied: nothing to redraw from.
    expect(m.vectors).toBeNull();
  });

  it('picks the nearest papers by vector from the nearest on the map, and sends every vector', async () => {
    // On the map n0 is nearest; by vector the first ten are the farthest from the paper.
    const line = Array.from({ length: MINIMAP_NEAREST + 10 }, (_, k) => ({
      slug: `n${k}`,
      x: k + 1,
      y: 0,
      vector: k < 10 ? [0, 1] : [1000, k],
    }));
    for (const slug of ['c', 'far', ...line.map((p) => p.slug)]) await post({ slug, title: slug });
    await putMap([{ slug: 'c', x: 0, y: 0, vector: [1, 0] }, { slug: 'far', x: 1000, y: 0, vector: [0, -1] }, ...line]);
    await putRelated('c', ['far', 'n0']);

    const m = (await minimap('c'))!;
    const slugs = m.points.map((p) => p.slug);
    expect(slugs.filter((s) => s.startsWith('n'))).toHaveLength(MINIMAP_NEAREST + 1);
    // n0 is related, so it stays; n1–n9 are near on the map but far by vector.
    expect(slugs).toContain('n0');
    for (let k = 1; k < 10; k++) expect(slugs).not.toContain(`n${k}`);
    expect(slugs).toContain(`n${MINIMAP_NEAREST + 9}`);
    expect(m.vectors).toEqual(
      m.points.map((p) => (p.slug === 'c' ? [1, 0] : (line.find((l) => l.slug === p.slug)?.vector ?? [0, -1]))),
    );
  });
});
