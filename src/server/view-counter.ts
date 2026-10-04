import { createHmac } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { getDb, type Database } from '@/db';
import { ipNetwork } from '@/lib/ip-network';

/**
 * Unique viewers per day of a listing.
 *
 * A visitor is a signed-in account, or else a network: the client's IPv4
 * address, or its IPv6 /64 (`lib/ip-network.ts`), from `Cf-Connecting-Ip` via
 * `clientIp()`, so it is the real client behind Cloudflare. Never the user
 * agent, which the client chooses: with it in, one machine was as many
 * visitors as it cared to name. So anonymous readers behind one NAT count
 * once; signed-in ones count each. What is stored is an HMAC of the day and
 * that identity under the server secret: no address or account id, and as the
 * day is inside the hash one day's visitor cannot be linked to the next.
 * The same visitor on the same day is one row (the primary key), and
 * `listings.view_count` goes up only when the row is new, in one statement.
 *
 * Counted by a beacon from the browser, not on render: a page served from
 * Cloudflare's cache never reaches the origin, and a crawler that runs no
 * script is not a viewer. Not a source of truth (§1.4): it writes no events.
 *
 * The same beacon may name the listing the visitor read just before
 * (`countTransition`), for the similarity service: counted the same way, per
 * ordered pair, and kept only as a total per pair.
 */

/** Who is viewing: the account when there is one, else the client's network. */
export interface Viewer {
  accountId?: string | null;
  ip: string | null;
}

function who(viewer: Viewer): string {
  return viewer.accountId ? `account:${viewer.accountId}` : `net:${ipNetwork(viewer.ip) ?? ''}`;
}

function hmac(message: string): string {
  return createHmac('sha256', process.env.BETTER_AUTH_SECRET ?? '')
    .update(message)
    .digest('hex');
}

export function visitorHash(day: string, viewer: Viewer): string {
  return hmac(`view\0${day}\0${who(viewer)}`);
}

/** The pair is inside the hash, so a row joins neither to a view nor to the visitor's other pairs. */
export function transitionHash(day: string, viewer: Viewer, fromListingId: string, toListingId: string): string {
  return hmac(`transition\0${day}\0${who(viewer)}\0${fromListingId}\0${toListingId}`);
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
  viewer: Viewer,
  now: Date = new Date(),
  database: Database = getDb(),
): Promise<number | null> {
  const day = utcDay(now);
  const visitor = visitorHash(day, viewer);
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

/**
 * Count the visitor as having read `toListingId` after `fromListingId` today:
 * once a day per visitor and ordered pair, summed into `listing_transitions`.
 * Nothing is counted for a listing to itself or from a listing that does not
 * exist. Returns whether the count went up.
 */
export async function countTransition(
  fromListingId: string,
  toListingId: string,
  viewer: Viewer,
  now: Date = new Date(),
  database: Database = getDb(),
): Promise<boolean> {
  if (fromListingId === toListingId) return false;
  const day = utcDay(now);
  const visitor = transitionHash(day, viewer, fromListingId, toListingId);
  const result = await database.execute(sql`
    with ins as (
      insert into listing_transition_visits (day, visitor)
      select ${day}::date, ${visitor}
       where exists (select 1 from listings where id = ${fromListingId}::uuid)
         and exists (select 1 from listings where id = ${toListingId}::uuid)
      on conflict do nothing
      returning 1
    )
    insert into listing_transitions (from_listing_id, to_listing_id, count)
    select ${fromListingId}::uuid, ${toListingId}::uuid, 1 from ins
    on conflict (from_listing_id, to_listing_id) do update set count = listing_transitions.count + 1
    returning 1
  `);
  if (Math.random() < 0.01) {
    await database.execute(
      sql`delete from listing_transition_visits where day < ${utcDay(new Date(now.getTime() - 86_400_000))}::date`,
    );
  }
  return result.rows.length > 0;
}
