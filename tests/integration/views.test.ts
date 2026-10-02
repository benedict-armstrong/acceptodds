import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '@/db';
import { listingViews } from '@/db/schema';
import { upsertListing } from '@/server/listings';
import { countView } from '@/server/view-counter';
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
