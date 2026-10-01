import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '@/db';
import { listingViews } from '@/db/schema';
import { upsertListing } from '@/server/listings';
import { countView } from '@/server/view-counter';
import { api } from './api-client';
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

const view = (slug: string, ip: string, ua = 'Mozilla/5.0') =>
  api('POST', `/listings/${slug}/view`, { headers: { 'cf-connecting-ip': ip, 'user-agent': ua } });

describe('POST /listings/{id}/view', () => {
  it('counts a visitor once a day, and a different visitor again', async () => {
    const { listing } = await upsertListing({ slug: 'one', title: 'One' });
    expect((await view('one', '203.0.113.1')).body).toEqual({ listingId: listing.id, views: 1 });
    expect((await view('one', '203.0.113.1')).body.views).toBe(1);
    expect((await view('one', '203.0.113.2')).body.views).toBe(2);
    expect((await view('one', '203.0.113.1', 'curl/8')).body.views).toBe(3);
    expect((await api('GET', '/listings/one')).body.views).toBe(3);
  });

  it('counts the same visitor again on the next day, and stores no address', async () => {
    const { listing } = await upsertListing({ slug: 'one', title: 'One' });
    const today = new Date();
    const tomorrow = new Date(today.getTime() + 86_400_000);
    expect(await countView(listing.id, '203.0.113.1', 'ua', today)).toBe(1);
    expect(await countView(listing.id, '203.0.113.1', 'ua', tomorrow)).toBe(2);
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
