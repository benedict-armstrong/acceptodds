import { sql } from 'drizzle-orm';
import type { Database } from './index';

/** Reset accounts and trading; paper data survives unless explicitly opted out. */
export async function wipeSeedData(db: Database, keepListings = true) {
  const { rows } = await db.execute<{ t: string }>(
    sql`select format('%I', tablename) as t from pg_tables where schemaname = 'public'
        and (not ${keepListings} or tablename not in (
          'listings', 'listing_references', 'listing_related', 'listing_views', 'map_points', 'map_topics'
        ))`,
  );
  if (rows.length > 0) {
    await db.execute(sql.raw(`truncate table ${rows.map((r) => r.t).join(', ')} restart identity cascade`));
  }
  console.log(`wiped ${rows.length} tables${keepListings ? '; paper data preserved' : ''}`);
}
