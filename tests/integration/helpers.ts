import { sql } from 'drizzle-orm';
import { getDb, getPool } from '@/db';

const db = getDb();
import { createAccount, createHouse } from '@/server/accounts';
import { createMarket } from '@/server/engine';
import { invalidateMap } from '@/server/map-cache';
import { invalidateStandings } from '@/server/standings-cache';

export const STARTING_MICRO = 1_000_000_000n; // 1000 units
export const HOUSE_MICRO = 1_000_000_000_000n; // 1,000,000 units

export async function resetDatabase(): Promise<void> {
  await db.execute(sql`
    truncate table
      events, ledger_entries, orders, positions, outcomes,
      listings, listing_references, markets, usd_costs, rate_limit_buckets, comment_backings, comment_aliases, comments, listing_follows, listing_views, listing_transitions, listing_transition_visits, digest_sends, field_snapshots, affiliations, pending_bets, group_members, groups, map_points, map_topics, accounts,
      apikey, session, account, verification, "user"
    restart identity cascade
  `);
  // Truncating is a write the engine never saw.
  invalidateStandings();
  invalidateMap();
}

export async function closePool(): Promise<void> {
  await getPool()
    .end()
    .catch(() => {});
}

export interface Fixture {
  houseId: string;
  traderIds: string[];
  marketId: string;
  outcomeIds: string[];
  b: number;
  subsidyMicro: bigint;
  /** Total reputation ever granted; the conservation target. */
  grantedMicro: bigint;
}

export async function seedMarket(traders = 10, expectedTraders = traders): Promise<Fixture> {
  const house = await createHouse(HOUSE_MICRO, db);

  const traderIds: string[] = [];
  for (let i = 0; i < traders; i += 1) {
    const account = await createAccount(
      { handle: `trader-${i}`, displayName: `Trader ${i}`, grantMicro: STARTING_MICRO },
      db,
    );
    traderIds.push(account.id);
  }

  const market = await createMarket(
    {
      slug: 'concurrency',
      question: 'Will the thing happen?',
      outcomes: ['YES', 'NO'],
      closesAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      startingBalanceMicro: STARTING_MICRO,
      expectedTraders,
      status: 'open',
    },
    db,
  );

  return {
    houseId: house.id,
    traderIds,
    marketId: market.marketId,
    outcomeIds: market.outcomeIds,
    b: market.b,
    subsidyMicro: market.subsidyMicro,
    grantedMicro: HOUSE_MICRO + STARTING_MICRO * BigInt(traders),
  };
}
