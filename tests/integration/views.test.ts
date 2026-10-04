import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '@/db';
import { listingTransitionVisits, listingViews } from '@/db/schema';
import { upsertListing } from '@/server/listings';
import { countTransition, countView } from '@/server/view-counter';
import { api, signUp, trader } from './api-client';
import { closePool, resetDatabase } from './helpers';

const db = getDb();

beforeEach(async () => {
  await resetDatabase();
  process.env.API_RATE_LIMIT_BURST = '1000';
  process.env.API_RATE_LIMIT_PER_SECOND = '1000';
}, 60_000);

afterAll(async () => {
  await closePool();
});

const view = (slug: string, ip: string, opts: { ua?: string; cookie?: string; token?: string } = {}) =>
  api('POST', `/listings/${slug}/view`, {
    cookie: opts.cookie,
    token: opts.token,
    headers: { 'cf-connecting-ip': ip, 'user-agent': opts.ua ?? 'Mozilla/5.0' },
  });

describe('POST /listings/{id}/view', () => {
  it('counts a visitor once a day, and a different visitor again', async () => {
    const { listing } = await upsertListing({ slug: 'one', title: 'One' });
    expect((await view('one', '203.0.113.1')).body).toEqual({ listingId: listing.id, views: 1 });
    expect((await view('one', '203.0.113.1')).body.views).toBe(1);
    expect((await view('one', '203.0.113.2')).body.views).toBe(2);
    expect((await api('GET', '/listings/one')).body.views).toBe(2);
  });

  it('counts a network once, whatever user agent it sends', async () => {
    await upsertListing({ slug: 'one', title: 'One' });
    for (let i = 0; i < 5; i++) await view('one', '203.0.113.1', { ua: `bot ${i}` });
    expect((await api('GET', '/listings/one')).body.views).toBe(1);
  });

  it('counts an IPv6 /64 once, whichever address in it sends', async () => {
    await upsertListing({ slug: 'one', title: 'One' });
    await view('one', '2001:db8:1:2::1');
    await view('one', '2001:db8:1:2:ffff:ffff:ffff:ffff');
    expect((await view('one', '2001:db8:1:3::1')).body.views).toBe(2);
  });

  it('counts each signed-in account once, apart from its network', async () => {
    await upsertListing({ slug: 'one', title: 'One' });
    const cookie = await signUp('reader@example.org');
    const bot = await trader('bot', ['read'], { isBot: true });
    await view('one', '203.0.113.1');
    // Two people behind the anonymous reader's NAT, each signed in.
    expect((await view('one', '203.0.113.1', { cookie })).body.views).toBe(2);
    expect((await view('one', '203.0.113.1', { token: bot.token })).body.views).toBe(3);
    // The same account from elsewhere, or again, is not new.
    expect((await view('one', '198.51.100.7', { cookie })).body.views).toBe(3);
    expect((await view('one', '203.0.113.1', { token: bot.token })).body.views).toBe(3);
  });

  it('counts the same visitor again on the next day, and stores no address', async () => {
    const { listing } = await upsertListing({ slug: 'one', title: 'One' });
    const today = new Date();
    const tomorrow = new Date(today.getTime() + 86_400_000);
    expect(await countView(listing.id, { ip: '203.0.113.1' }, today)).toBe(1);
    expect(await countView(listing.id, { ip: '203.0.113.1' }, tomorrow)).toBe(2);
    const rows = await db.select().from(listingViews);
    expect(rows).toHaveLength(2);
    expect(rows[0].visitor).not.toBe(rows[1].visitor);
    expect(JSON.stringify(rows)).not.toContain('203.0.113.1');
  });

  it('is a 404 for an unknown listing', async () => {
    const res = await view('nope', '203.0.113.1');
    expect(res.status).toBe(404);
  });
});

describe('transitions (?from= on the view beacon)', () => {
  const after = (slug: string, from: string, ip: string) =>
    api('POST', `/listings/${slug}/view?from=${from}`, {
      headers: { 'cf-connecting-ip': ip, 'user-agent': 'Mozilla/5.0' },
    });
  const transitions = async (query = '') => {
    const admin = await trader('similarity', ['admin']);
    return api('GET', `/transitions${query}`, { token: admin.token });
  };

  it('counts each ordered pair once per visitor per day, and keeps only the total', async () => {
    const { listing: a } = await upsertListing({ slug: 'a', title: 'A' });
    const { listing: b } = await upsertListing({ slug: 'b', title: 'B' });
    await after('b', a.id, '203.0.113.1');
    await after('b', a.id, '203.0.113.1');
    await after('b', a.id, '203.0.113.2');
    await after('a', b.id, '203.0.113.1');
    const res = await transitions();
    expect(res.status).toBe(200);
    expect(res.body.transitions).toEqual([
      { from: 'a', to: 'b', count: 2 },
      { from: 'b', to: 'a', count: 1 },
    ]);
    const visits = JSON.stringify(await db.select().from(listingTransitionVisits));
    expect(visits).not.toContain('203.0.113');
    expect(visits).not.toContain(a.id);
  });

  it('hashes each pair apart, so a visitor’s pairs and views cannot be joined', async () => {
    const { listing: a } = await upsertListing({ slug: 'a', title: 'A' });
    const { listing: b } = await upsertListing({ slug: 'b', title: 'B' });
    const { listing: c } = await upsertListing({ slug: 'c', title: 'C' });
    const viewer = { ip: '203.0.113.1' };
    await countTransition(a.id, c.id, viewer);
    await countTransition(b.id, c.id, viewer);
    await countView(c.id, viewer);
    const hashes = [
      ...(await db.select().from(listingTransitionVisits)).map((r) => r.visitor),
      ...(await db.select().from(listingViews)).map((r) => r.visitor),
    ];
    expect(new Set(hashes).size).toBe(3);
  });

  it('counts the view whatever `from` is, and no transition to itself, from junk or from an unknown listing', async () => {
    const { listing: a } = await upsertListing({ slug: 'a', title: 'A' });
    expect((await after('a', a.id, '203.0.113.1')).body.views).toBe(1);
    expect((await after('a', 'not-a-uuid', '203.0.113.2')).body.views).toBe(2);
    expect((await after('a', randomUUID(), '203.0.113.3')).body.views).toBe(3);
    expect((await transitions()).body.transitions).toEqual([]);
  });

  it('filters by `min`, and is admin-only', async () => {
    const { listing: a } = await upsertListing({ slug: 'a', title: 'A' });
    const { listing: b } = await upsertListing({ slug: 'b', title: 'B' });
    await upsertListing({ slug: 'c', title: 'C' });
    await after('b', a.id, '203.0.113.1');
    await after('b', a.id, '203.0.113.2');
    await after('c', b.id, '203.0.113.1');
    expect((await transitions('?min=2')).body.transitions).toEqual([{ from: 'a', to: 'b', count: 2 }]);
    expect((await api('GET', '/transitions')).status).toBe(401);
    const reader = await trader('reader', ['read']);
    expect((await api('GET', '/transitions', { token: reader.token })).status).toBe(403);
  });
});
