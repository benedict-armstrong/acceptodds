import { and, asc, desc, eq, inArray, lte, sql } from 'drizzle-orm';
import { getDb, type Database } from '@/db';
import { accounts, listingFollows, listings, orders, type Listing } from '@/db/schema';
import { moveOf, type Move } from '@/lib/digest';
import { prices } from '@/lib/lmsr';
import { microToFloat } from '@/lib/money';
import { listingViews, type ListingView, type MarketView } from './views';

/**
 * Following ("starring") listings. The UI calls a listing a paper; here it is
 * an opaque subject like everywhere else. Only listings can be followed.
 *
 * A follow is a preference: no money, no market state. Each write is a single
 * statement of its own, never inside a trade, and idempotent — following
 * twice or unfollowing something not followed is not an error.
 */

export async function follow(accountId: string, listingId: string, database: Database = getDb()): Promise<boolean> {
  const rows = await database
    .insert(listingFollows)
    .values({ accountId, listingId })
    .onConflictDoNothing()
    .returning({ accountId: listingFollows.accountId });
  return rows.length > 0;
}

export async function unfollow(accountId: string, listingId: string, database: Database = getDb()): Promise<boolean> {
  const rows = await database
    .delete(listingFollows)
    .where(and(eq(listingFollows.accountId, accountId), eq(listingFollows.listingId, listingId)))
    .returning({ accountId: listingFollows.accountId });
  return rows.length > 0;
}

/** The ids of the listings an account follows. */
export async function followedListingIds(accountId: string, database: Database = getDb()): Promise<Set<string>> {
  const rows = await database
    .select({ listingId: listingFollows.listingId })
    .from(listingFollows)
    .where(eq(listingFollows.accountId, accountId));
  return new Set(rows.map((r) => r.listingId));
}

// ---------------------------------------------------------------------------
// moves: a main market's headline price now vs. `windowMs` ago
// ---------------------------------------------------------------------------

export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The headline move of each market over `[now − windowMs, now]`.
 *
 * The price then is **replayed exactly**, as `views.priceHistory` does: LMSR
 * prices are a function of the share vector, and the share vector at a time
 * is the sum of order shares up to it. One aggregate query for all markets.
 * A market created inside the window starts from its opening vector
 * (`outcomes.opening_shares_micro`: zeros, or its prior), which is what the
 * replay gives.
 */
export async function moves(
  views: MarketView[],
  now: Date = new Date(),
  windowMs = DAY_MS,
  database: Database = getDb(),
): Promise<Map<string, Move>> {
  const out = new Map<string, Move>();
  if (views.length === 0) return out;
  const cutoff = new Date(now.getTime() - windowMs);
  const then = await database
    .select({
      marketId: orders.marketId,
      outcomeId: orders.outcomeId,
      // sum(bigint) is numeric: read it as text, never as a JS number (§1.6).
      total: sql<string>`sum(${orders.sharesMicro})::text`,
    })
    .from(orders)
    .where(
      and(
        inArray(
          orders.marketId,
          views.map((v) => v.market.id),
        ),
        lte(orders.createdAt, cutoff),
      ),
    )
    .groupBy(orders.marketId, orders.outcomeId);

  for (const v of views) {
    const sharesThen = v.outcomes.map((o) => {
      const row = then.find((r) => r.marketId === v.market.id && r.outcomeId === o.id);
      return microToFloat(o.openingSharesMicro + (row ? BigInt(row.total) : 0n));
    });
    out.set(
      v.market.id,
      moveOf(
        prices(sharesThen, v.market.b),
        v.outcomes.map((o) => o.price),
      ),
    );
  }
  return out;
}

export interface FollowedListing {
  view: ListingView;
  followedAt: Date;
  /** The main market (lowest rank), or null if the listing has none visible. */
  main: MarketView | null;
  /** Its headline move over the last 24h, or null without a main market. */
  move: Move | null;
}

/** Everything an account follows, most recently followed first, with each main market's 24h move. */
export async function followedListings(
  accountId: string,
  now: Date = new Date(),
  database: Database = getDb(),
): Promise<FollowedListing[]> {
  const rows = await database
    .select({ listing: listings, followedAt: listingFollows.createdAt })
    .from(listingFollows)
    .innerJoin(listings, eq(listings.id, listingFollows.listingId))
    .where(eq(listingFollows.accountId, accountId))
    .orderBy(desc(listingFollows.createdAt), asc(listings.id));
  return withMoves(
    rows.map((r) => r.listing),
    rows.map((r) => r.followedAt),
    now,
    database,
  );
}

async function withMoves(ls: Listing[], followedAt: Date[], now: Date, database: Database): Promise<FollowedListing[]> {
  const views = await listingViews(ls, database);
  const mains = views.map((v) => v.markets[0] ?? null);
  const m = await moves(
    mains.filter((x): x is MarketView => x !== null),
    now,
    DAY_MS,
    database,
  );
  return views.map((view, i) => ({
    view,
    followedAt: followedAt[i],
    main: mains[i],
    move: mains[i] ? (m.get(mains[i]!.market.id) ?? null) : null,
  }));
}

/** Set whether a comment's `@` mention may be mailed to this account. */
export async function setMentionMailOptIn(accountId: string, optIn: boolean, database: Database = getDb()) {
  const [row] = await database
    .update(accounts)
    .set({ mentionMailOptIn: optIn })
    .where(eq(accounts.id, accountId))
    .returning();
  return row;
}

/** Set whether the daily digest may be mailed to this account. */
export async function setDigestOptIn(accountId: string, optIn: boolean, database: Database = getDb()) {
  const [row] = await database
    .update(accounts)
    .set({ digestOptIn: optIn })
    .where(eq(accounts.id, accountId))
    .returning();
  return row;
}
