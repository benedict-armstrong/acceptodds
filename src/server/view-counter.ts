import { createHmac } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { getDb, type Database } from '@/db';

/**
 * Unique viewers per day of a listing.
 *
 * A visitor is an HMAC of the UTC day, their IP and user agent
 * (`Cf-Connecting-Ip`, via `clientIp()`, so it is the real client behind
 * Cloudflare), keyed by the server secret. The address is never stored, and as
 * the day is inside the hash one day's visitor cannot be linked to the next.
 * The same visitor on the same day is one row (the primary key), and
 * `listings.view_count` goes up only when the row is new, in one statement.
 *
 * Counted by a beacon from the browser, not on render: a page served from
 * Cloudflare's cache never reaches the origin, and a crawler that runs no
 * script is not a viewer. Not a source of truth (§1.4): it writes no events.
 */

export function visitorHash(day: string, ip: string | null, userAgent: string | null): string {
  const key = process.env.BETTER_AUTH_SECRET ?? '';
  return createHmac('sha256', key)
    .update(`view\0${day}\0${ip ?? ''}\0${userAgent ?? ''}`)
    .digest('hex');
}

/** A date in UTC, as `YYYY-MM-DD`. */
function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/**
 * Count the visitor as having viewed the listing today. Returns the listing's
 * total views after, or `null` when the listing does not exist.
 */
export async function countView(
  listingId: string,
  ip: string | null,
  userAgent: string | null,
  now: Date = new Date(),
  database: Database = getDb(),
): Promise<number | null> {
  const day = utcDay(now);
  const visitor = visitorHash(day, ip, userAgent);
  const result = await database.execute<{ view_count: number }>(sql`
    with found as (select view_count from listings where id = ${listingId}::uuid),
    ins as (
      insert into listing_views (listing_id, day, visitor)
      select ${listingId}::uuid, ${day}::date, ${visitor} from found
      on conflict do nothing
      returning 1
    ),
    bump as (
      update listings set view_count = view_count + 1
      where id = ${listingId}::uuid and exists (select 1 from ins)
      returning view_count
    )
    select coalesce((select view_count from bump), (select view_count from found)) as view_count
      from found
  `);
  // Old rows only exist to dedupe today: sweep now and then, not on every view.
  if (Math.random() < 0.01) {
    await database.execute(
      sql`delete from listing_views where day < ${utcDay(new Date(now.getTime() - 86_400_000))}::date`,
    );
  }
  const row = result.rows[0];
  return row ? Number(row.view_count) : null;
}
