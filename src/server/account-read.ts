import { cache } from 'react';
import { and, asc, eq, inArray, ne } from 'drizzle-orm';
import { getDb } from '@/db';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from '@/db/schema';
import { accounts, listings, markets, outcomes, positions, type Outcome } from '@/db/schema';
import { boardFromOutcomes } from './engine';

type Database = NodePgDatabase<typeof schema>;

/** Request-scoped inputs shared by the navbar valuation and the page's portfolio. Never shared between requests. */
export function accountHoldings(accountId: string, database: Database = getDb()) {
  return database === getDb() ? cachedHoldings(accountId, database) : readHoldings(accountId, database);
}

const cachedHoldings = cache(readHoldings);

async function readHoldings(accountId: string, database: Database) {
  const [account] = await database.select().from(accounts).where(eq(accounts.id, accountId));
  if (!account) return null;
  const rows = await database
    .select({
      position: positions,
      outcome: outcomes,
      market: markets,
      listingSlug: listings.slug,
      listingTitle: listings.title,
    })
    .from(positions)
    .innerJoin(outcomes, eq(positions.outcomeId, outcomes.id))
    .innerJoin(markets, eq(outcomes.marketId, markets.id))
    .leftJoin(listings, eq(listings.id, markets.listingId))
    .where(and(eq(positions.accountId, accountId), ne(positions.sharesMicro, 0n)))
    .orderBy(asc(markets.slug), asc(outcomes.ordinal));
  const ids = [...new Set(rows.map((r) => r.market.id))];
  const outcomeRows =
    ids.length === 0
      ? []
      : await database
          .select()
          .from(outcomes)
          .where(inArray(outcomes.marketId, ids))
          .orderBy(asc(outcomes.marketId), asc(outcomes.ordinal));
  const grouped = new Map<string, Outcome[]>();
  for (const o of outcomeRows) {
    const group = grouped.get(o.marketId) ?? [];
    group.push(o);
    grouped.set(o.marketId, group);
  }
  const marketRows = new Map(rows.map((r) => [r.market.id, r.market]));
  const boards = new Map(ids.map((id) => [id, boardFromOutcomes(marketRows.get(id)!, grouped.get(id) ?? [])]));
  return { account, rows, boards };
}
