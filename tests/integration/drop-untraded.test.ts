/* eslint-disable @typescript-eslint/no-explicit-any -- response bodies are checked field by field */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { getDb } from '@/db';
import { dropUntradedMarkets } from '@/db/drop-untraded';
import { accounts, comments, markets } from '@/db/schema';
import { postComment } from '@/server/comments';
import { createMarket, HOUSE_HANDLE, trade } from '@/server/engine';
import { upsertListing } from '@/server/listings';
import { api, trader } from './api-client';
import { closePool, resetDatabase, seedMarket, STARTING_MICRO, type Fixture } from './helpers';

const db = getDb();
const UNIT = 1_000_000n;
let fx: Fixture;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-01T00:00:00Z') });
  await resetDatabase();
  process.env.API_RATE_LIMIT_BURST = '1000';
  process.env.API_RATE_LIMIT_PER_SECOND = '1000';
  process.env.STARTING_BALANCE_MICRO = STARTING_MICRO.toString();
  delete process.env.NANOGPT_API_KEY;
  fx = await seedMarket(2, 10);
}, 60_000);

afterEach(() => {
  vi.useRealTimers();
});

afterAll(async () => {
  await closePool();
});

/** A listing with its seeded main market, as `db:seed` used to make them. */
async function seeded(slug: string, extra: { secondary?: boolean } = {}) {
  const { listing } = await upsertListing({ slug, title: `Paper ${slug}`, kind: 'ICLR 2027' });
  const base = {
    outcomes: ['Accept', 'Reject'],
    openingPrices: [0.32, 0.68],
    closesAt: new Date('2026-12-14T00:00:00Z'),
    startingBalanceMicro: STARTING_MICRO,
    expectedTraders: 6,
    kind: 'ICLR 2027',
    listingId: listing.id,
  };
  const m = await createMarket({ ...base, slug: `${slug}-decision`, question: `${slug}?`, listingRank: 0 });
  if (extra.secondary) {
    await createMarket({ ...base, slug: `${slug}-other`, question: `${slug} other?`, listingRank: 1 });
  }
  return { listing, ...m };
}

const totalBalance = async () =>
  (await db.execute<{ s: string }>(sql`select sum(balance_micro)::text as s from accounts`)).rows[0].s;
const ledgerTotal = async () =>
  (await db.execute<{ s: string }>(sql`select coalesce(sum(delta_micro), 0)::text as s from ledger_entries`)).rows[0].s;
const slugs = async () => (await db.select({ slug: markets.slug }).from(markets)).map((m) => m.slug).sort();
const treasury = async () => (await db.select().from(accounts).where(eq(accounts.handle, HOUSE_HANDLE)))[0];

describe('dropUntradedMarkets', () => {
  it('deletes only untraded sole main markets, gives the subsidy back, and leaves the totals unchanged', async () => {
    const untraded = await seeded('untraded');
    await seeded('untraded-2');
    const traded = await seeded('traded');
    await trade(fx.traderIds[0], traded.marketId, traded.outcomeIds[0], 5n * UNIT, 1_000n * UNIT);
    await seeded('two-markets', { secondary: true });
    const commented = await seeded('commented');
    await postComment({ marketId: commented.marketId, accountId: fx.traderIds[1], body: 'hm' });
    const sum = await totalBalance();
    const before = await treasury();

    // A dry run reports exactly, and changes nothing.
    const dry = await dropUntradedMarkets(db, { apply: false, batch: 1 });
    expect(dry).toMatchObject({ markets: 2, comments: 0, skippedCommented: 1 });
    expect(dry.refundedMicro).toBe(untraded.subsidyMicro * 2n);
    expect(await slugs()).toHaveLength(7);

    const done = await dropUntradedMarkets(db, { apply: true, batch: 1 });
    expect(done).toEqual(dry);
    expect(await slugs()).toEqual([
      'commented-decision',
      'concurrency',
      'traded-decision',
      'two-markets-decision',
      'two-markets-other',
    ]);
    // The makers are gone with their markets; balances still sum as before, and to the ledger.
    expect(await db.select().from(accounts).where(eq(accounts.handle, 'market:untraded-decision'))).toHaveLength(0);
    expect(await totalBalance()).toBe(sum);
    expect(await ledgerTotal()).toBe(await totalBalance());
    expect((await treasury()).balanceMicro).toBe(before.balanceMicro + done.refundedMicro);

    // With comments too.
    const more = await dropUntradedMarkets(db, { apply: true, includeCommented: true });
    expect(more).toMatchObject({ markets: 1, comments: 1, skippedCommented: 0 });
    expect(await db.select().from(comments)).toHaveLength(0);
    expect(await ledgerTotal()).toBe(await totalBalance());
  });

  it('frees the listing for the first trade to make its market again', async () => {
    const { listing } = await seeded('p');
    await dropUntradedMarkets(db, { apply: true });
    const t = await trader('t');
    const res = await api('POST', `/listings/${listing.id}/orders`, {
      token: t.token,
      body: { outcome: 'Accept', stakeMicro: '1000000' },
    });
    expect(res.status).toBe(201);
    expect((res.body as any).marketCreated).toBe(true);
    expect(await slugs()).toEqual(['concurrency', 'p-decision']);
  });
});
