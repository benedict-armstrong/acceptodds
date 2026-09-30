import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { and, asc, eq, ne, sql } from 'drizzle-orm';
import { getDb } from '@/db';
import { markets } from '@/db/schema';
import { marketHeadline } from '@/lib/headline';
import { createMarket, settle, trade } from '@/server/engine';
import { follow } from '@/server/follows';
import { upsertListing } from '@/server/listings';
import { browseListings, marketView } from '@/server/views';
import { closePool, resetDatabase, seedMarket, STARTING_MICRO, type Fixture } from './helpers';

/**
 * Browse lists at venue scale (issue #12): the engine's caches on `markets`
 * that the sorts read instead of `orders`, the main-market flag that makes a
 * row one index entry, and offset pagination with a total.
 */

const db = getDb();
const UNIT = 1_000_000n;
let fx: Fixture;

beforeEach(async () => {
  await resetDatabase();
  fx = await seedMarket(3, 10);
}, 60_000);

afterAll(async () => {
  await closePool();
});

const base = {
  outcomes: ['Oral', 'Spotlight', 'Poster', 'Reject'],
  startingBalanceMicro: STARTING_MICRO,
  expectedTraders: 10,
  kind: 'venue',
  closesAt: new Date(Date.now() + 86_400_000),
};

async function mainIds(listingId: string): Promise<string[]> {
  const rows = await db
    .select({ id: markets.id })
    .from(markets)
    .where(and(eq(markets.listingId, listingId), eq(markets.isMain, true)));
  return rows.map((r) => r.id);
}

/** The visible market that `listingViews` puts first: lowest rank, then oldest. */
async function firstVisible(listingId: string): Promise<string> {
  const [row] = await db
    .select({ id: markets.id })
    .from(markets)
    .where(and(eq(markets.listingId, listingId), ne(markets.status, 'draft')))
    .orderBy(asc(markets.listingRank), asc(markets.createdAt), asc(markets.id))
    .limit(1);
  return row.id;
}

describe('markets.is_main', () => {
  it('is the visible market with the lowest rank, ties by age, never a draft', async () => {
    const { listing } = await upsertListing({ slug: 'p', title: 'P' });
    const make = (slug: string, listingRank: number, status: 'open' | 'draft' = 'open') =>
      createMarket({ ...base, slug, question: `${slug}?`, listingId: listing.id, listingRank, status });

    const oral = await make('oral', 2);
    expect(await mainIds(listing.id)).toEqual([oral.marketId]);
    const accept = await make('accept', 1);
    expect(await mainIds(listing.id)).toEqual([accept.marketId]); // a lower rank takes over
    await make('level', 1);
    expect(await mainIds(listing.id)).toEqual([accept.marketId]); // a tie goes to the older
    await make('staged', 0, 'draft');
    expect(await mainIds(listing.id)).toEqual([accept.marketId]); // a draft never
    expect(await firstVisible(listing.id)).toBe(accept.marketId);

    const [alone] = await db.select().from(markets).where(eq(markets.id, fx.marketId));
    expect(alone.isMain).toBe(true); // a market with no listing is its own row
  });

  it('stays one per listing, and the first visible one, when markets are created at once', async () => {
    const { listing } = await upsertListing({ slug: 'race', title: 'Race' });
    await Promise.all(
      [3, 1, 1, 2, 1, 0, 0, 4].map((rank, i) =>
        createMarket({ ...base, slug: `race-${i}`, question: `${i}?`, listingId: listing.id, listingRank: rank }),
      ),
    );
    const ids = await mainIds(listing.id);
    expect(ids).toHaveLength(1);
    expect(ids[0]).toBe(await firstVisible(listing.id));
  });
});

describe('the fill caches on markets', () => {
  it('match the fills after buys, sells and settlement', async () => {
    const m = await createMarket({ ...base, slug: 'cached', question: 'cached?' });
    const [a, b] = fx.traderIds;
    await trade(a, m.marketId, m.outcomeIds[0], 20n * UNIT, 1_000n * UNIT);
    await trade(b, m.marketId, m.outcomeIds[3], 35n * UNIT, 1_000n * UNIT);
    await trade(a, m.marketId, m.outcomeIds[0], -12n * UNIT, 0n); // a sell: negative cost, counted by size
    await Promise.all([
      trade(a, m.marketId, m.outcomeIds[2], 5n * UNIT, 1_000n * UNIT),
      trade(b, m.marketId, m.outcomeIds[1], 7n * UNIT, 1_000n * UNIT),
    ]);

    const check = async () => {
      const [truth] = (
        await db.execute<{ volume: string; n: number; last: string }>(sql`
          select sum(abs(cost_micro))::text as volume, count(*)::int as n, max(created_at)::text as last
            from orders where market_id = ${m.marketId}`)
      ).rows;
      const [cached] = (
        await db.execute<{ volume: string; n: number; last: string; headline: number }>(sql`
          select volume_micro::text as volume, order_count as n, last_trade_at::text as last, headline
            from markets where id = ${m.marketId}`)
      ).rows;
      expect({ volume: cached.volume, n: cached.n, last: cached.last }).toEqual(truth); // to the microsecond
      const view = await marketView((await db.select().from(markets).where(eq(markets.id, m.marketId)))[0]);
      expect(cached.headline).toBeCloseTo(marketHeadline({ ...view.market, outcomes: view.outcomes })!, 12);
      expect(view.volumeMicro).toBe(BigInt(truth.volume));
      expect(view.orderCount).toBe(truth.n);
    };
    await check();
    expect(await db.select().from(markets).where(eq(markets.id, m.marketId))).toMatchObject([{ orderCount: 5 }]);

    await settle(m.marketId, m.outcomeIds[3]); // Reject: the headline is 0
    await check();
    const [settled] = await db.select().from(markets).where(eq(markets.id, m.marketId));
    expect(settled.headline).toBe(0);
  });

  it('start at the opening headline and no fills', async () => {
    const m = await createMarket({ ...base, slug: 'fresh', question: 'fresh?' });
    const [row] = await db.select().from(markets).where(eq(markets.id, m.marketId));
    expect(row).toMatchObject({ volumeMicro: 0n, orderCount: 0, lastTradeAt: null });
    expect(row.headline).toBeCloseTo(0.75, 12);
  });
});

describe('browseListings pages', () => {
  it('pages by offset with a total, and past the end still gives the total', async () => {
    for (let i = 0; i < 7; i += 1) await createMarket({ ...base, slug: `m${i}`, question: `${i}?` });
    const whole = await browseListings({ kind: 'venue', sort: 'newest', limit: 100 });
    expect(whole.total).toBe(7);
    const pages = [];
    for (const offset of [0, 3, 6]) {
      const page = await browseListings({ kind: 'venue', sort: 'newest', offset, limit: 3 });
      expect(page.total).toBe(7);
      pages.push(...page.rows.map((r) => r.market.slug));
    }
    expect(pages).toEqual(whole.rows.map((r) => r.market.slug));
    expect(await browseListings({ kind: 'venue', sort: 'newest', offset: 9, limit: 3 })).toEqual({ rows: [], total: 7 });
    expect(await browseListings({ kind: 'nowhere', sort: 'newest' })).toEqual({ rows: [], total: 0 });
  });

  it('splits into followed, held and the rest with no row in two', async () => {
    const [me] = fx.traderIds;
    const listed = [];
    for (const slug of ['f', 'h', 'fh', 'x']) {
      const { listing } = await upsertListing({ slug, title: slug });
      const m = await createMarket({ ...base, slug: `${slug}-main`, question: `${slug}?`, listingId: listing.id });
      listed.push({ slug, listing, m });
    }
    // Held through a secondary market: the row still counts as held.
    const second = await createMarket({
      ...base,
      slug: 'h-second',
      question: 'h second?',
      listingId: listed[1].listing.id,
      listingRank: 1,
    });
    await follow(me, listed[0].listing.id);
    await follow(me, listed[2].listing.id);
    await trade(me, second.marketId, second.outcomeIds[0], 5n * UNIT, 1_000n * UNIT);
    await trade(me, listed[2].m.marketId, listed[2].m.outcomeIds[0], 5n * UNIT, 1_000n * UNIT);

    const slugs = async (q: Omit<Parameters<typeof browseListings>[0], 'sort' | 'kind'>) => {
      const page = await browseListings({ kind: 'venue', sort: 'closing', ...q });
      expect(page.total).toBe(page.rows.length);
      return page.rows.map((r) => r.listing?.slug ?? r.market.slug).sort();
    };
    expect(await slugs({ followedBy: me, exceptHeldBy: me })).toEqual(['f']);
    expect(await slugs({ heldBy: me })).toEqual(['fh', 'h']);
    expect(await slugs({ exceptFollowedBy: me, exceptHeldBy: me })).toEqual(['x']);

    const [h] = (await browseListings({ kind: 'venue', sort: 'closing', heldBy: me })).rows.filter((r) => r.listing?.slug === 'h');
    expect(h.marketCount).toBe(2);
    expect(h.totalOrderCount).toBe(1);
    expect(h.market.slug).toBe('h-main');
  });
});
