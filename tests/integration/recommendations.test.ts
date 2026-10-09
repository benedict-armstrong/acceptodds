import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { listings, type Listing } from '@/db/schema';
import { createMarket } from '@/server/engine';
import { follow } from '@/server/follows';
import { setRelated, upsertListing } from '@/server/listings';
import { canRecommend, recommendationScores } from '@/server/recommendations';
import { browseListings } from '@/server/views';
import { closePool, resetDatabase, seedMarket, STARTING_MICRO, type Fixture } from './helpers';

/** The home list's `recommended` sort (`server/recommendations.ts`, scored by `lib/recommend.ts`). */

let fx: Fixture;
let papers: Record<string, Listing>;

beforeEach(async () => {
  await resetDatabase();
  fx = await seedMarket(3);
  papers = {};
  for (const slug of ['a', 'b', 'c', 'd', 'e']) papers[slug] = (await upsertListing({ slug, title: slug })).listing;
  // `a`, `b` and `d` have markets; `c` and `e` have none.
  for (const slug of ['a', 'b', 'd'])
    await createMarket({
      slug: `${slug}-decision`,
      question: `${slug}?`,
      outcomes: ['Accept', 'Reject'],
      startingBalanceMicro: STARTING_MICRO,
      expectedTraders: 3,
      closesAt: new Date(Date.now() + 86_400_000),
      listingId: papers[slug].id,
      listingRank: 0,
      status: 'open',
    });
}, 60_000);

afterAll(async () => {
  await closePool();
});

async function recommended(accountId: string): Promise<string[]> {
  const { rows } = await browseListings({ sort: 'recommended', status: 'all', recommendFor: accountId, limit: 50 });
  return rows.flatMap((r) => (r.listing ? [r.listing.slug] : []));
}

const slugOf = async (id: string) =>
  (await getDb().select({ slug: listings.slug }).from(listings).where(eq(listings.id, id)))[0].slug;

describe('recommended sort', () => {
  it('ranks what is related to the viewer’s papers first, market or not, leaving out their own', async () => {
    const [me] = fx.traderIds;
    await follow(me, papers.a.id);
    await setRelated(papers.a, [
      { slug: 'c', score: 3 },
      { slug: 'b', score: 1 },
    ]);

    const scores = await recommendationScores(me);
    expect((await Promise.all([...scores.keys()].map(slugOf))).sort()).toEqual(['b', 'c']);
    expect(scores.get(papers.c.id)!).toBeGreaterThan(scores.get(papers.b.id)!);

    const order = await recommended(me);
    // `c` has no market and still leads; `a` is the viewer's own, listed below.
    expect(order.slice(0, 2)).toEqual(['c', 'b']);
    expect(order.indexOf('a')).toBeGreaterThan(1);
  });

  it('falls back to activity for a viewer with nothing to go on', async () => {
    const [me] = fx.traderIds;
    const { rows } = await browseListings({ sort: 'activity', status: 'all', limit: 50 });
    expect(await recommended(me)).toEqual(rows.flatMap((r) => (r.listing ? [r.listing.slug] : [])));
  });

  it('is offered after two interactions or one trade', async () => {
    const [me] = fx.traderIds;
    expect(await canRecommend(me)).toBe(false);
    await follow(me, papers.a.id);
    expect(await canRecommend(me)).toBe(false);
    await follow(me, papers.b.id);
    expect(await canRecommend(me)).toBe(true);
  });
});
