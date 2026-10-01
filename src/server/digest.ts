import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { getDb, type Database } from '@/db';
import { user } from '@/db/auth-schema';
import { accounts, digestSends, listingFollows, listings } from '@/db/schema';
import {
  DEFAULT_DIGEST_TIMEZONE,
  digestDay,
  minMovePp,
  movedEnough,
  renderDigest,
  type DigestItem,
} from '@/lib/digest';
import * as events from './events';
import { DAY_MS, moves } from './follows';
import { sendMail } from './mail';
import { listingViews, type MarketView } from './views';

/**
 * The daily morning digest: one mail per account listing the followed papers
 * whose main market's headline price moved by at least `DIGEST_MIN_MOVE_PP`
 * percentage points (default 5) over the 24 hours before the run.
 *
 * Run by `npm run digest:send` from a host cron (07:00 Europe/Zurich); the
 * app has no scheduler. Who gets one: a non-bot, non-house account with a
 * confirmed email, `digest_opt_in`, and at least one follow whose main market
 * is `open` or `closed` and moved enough. Nothing moved, nothing sent.
 *
 * **At most once per account per day** (the day in `DIGEST_TIMEZONE`). The
 * `digest_sends` row is inserted *before* the mail goes out, and a second run
 * that finds it sends nothing. A failure we can see (the mail call throws)
 * removes the row again so a re-run retries; a crash between the insert and
 * the send loses that day's mail rather than risk sending it twice.
 *
 * This reads market state and writes only `digest_sends`, in statements of
 * its own. It never touches the engine's tables.
 */

export interface DigestResult {
  day: string;
  /** Accounts considered: opted in, with a confirmed email and a follow. */
  considered: number;
  sent: number;
  /** Already sent today (an earlier run). */
  skippedAlreadySent: number;
  /** Nothing they follow moved enough. */
  skippedNoMoves: number;
  failed: { accountId: string; error: string }[];
}

export function appBaseUrl(): string {
  const url = process.env.APP_URL ?? process.env.BETTER_AUTH_URL;
  if (!url) throw new Error('APP_URL (or BETTER_AUTH_URL) is not set; digest links need it');
  return url;
}

export async function sendDailyDigest(
  opts: { now?: Date; minMovePp?: number; timeZone?: string; baseUrl?: string } = {},
  database: Database = getDb(),
): Promise<DigestResult> {
  const now = opts.now ?? new Date();
  const threshold = opts.minMovePp ?? minMovePp();
  const day = digestDay(now, opts.timeZone ?? process.env.DIGEST_TIMEZONE ?? DEFAULT_DIGEST_TIMEZONE);
  const baseUrl = opts.baseUrl ?? appBaseUrl();

  // Recipients and what they follow, in one read.
  const follows = await database
    .select({ accountId: accounts.id, email: user.email, listingId: listingFollows.listingId })
    .from(listingFollows)
    .innerJoin(accounts, eq(accounts.id, listingFollows.accountId))
    .innerJoin(user, eq(user.id, accounts.userId))
    .where(
      and(
        eq(accounts.digestOptIn, true),
        eq(accounts.isBot, false),
        eq(accounts.isHouse, false),
        eq(user.emailVerified, true),
      ),
    )
    .orderBy(asc(accounts.id));

  const result: DigestResult = { day, considered: 0, sent: 0, skippedAlreadySent: 0, skippedNoMoves: 0, failed: [] };
  if (follows.length === 0) return result;

  // Each followed listing's main market and its move, computed once.
  const listingIds = [...new Set(follows.map((f) => f.listingId))];
  const ls = await database.select().from(listings).where(inArray(listings.id, listingIds));
  const views = await listingViews(ls, database);
  const mains = new Map<string, MarketView>();
  for (const v of views) {
    const main = v.markets[0];
    if (main && (main.market.status === 'open' || main.market.status === 'closed')) mains.set(v.listing.id, main);
  }
  const moved = await moves([...mains.values()], now, DAY_MS, database);

  const items = new Map<string, DigestItem>();
  for (const v of views) {
    const main = mains.get(v.listing.id);
    const m = main && moved.get(main.market.id);
    if (!main || !m || !movedEnough(m, threshold)) continue;
    items.set(v.listing.id, {
      ...m,
      title: v.listing.title,
      slug: v.listing.slug,
      question: main.market.question,
      outcomeLabel: main.outcomes[m.ordinal].label,
      binary: main.outcomes.length === 2,
    });
  }

  const byAccount = new Map<string, { email: string; listingIds: string[] }>();
  for (const f of follows) {
    const entry = byAccount.get(f.accountId) ?? { email: f.email, listingIds: [] };
    entry.listingIds.push(f.listingId);
    byAccount.set(f.accountId, entry);
  }
  result.considered = byAccount.size;

  for (const [accountId, { email, listingIds: mine }] of byAccount) {
    const list = mine.map((id) => items.get(id)).filter((x): x is DigestItem => x !== undefined);
    if (list.length === 0) {
      result.skippedNoMoves += 1;
      continue;
    }
    // Insert first: this row is the "already sent today" guard.
    const claimed = await database
      .insert(digestSends)
      .values({ accountId, day })
      .onConflictDoNothing()
      .returning({ accountId: digestSends.accountId });
    if (claimed.length === 0) {
      result.skippedAlreadySent += 1;
      continue;
    }
    try {
      await sendMail({ to: email, ...renderDigest(list, baseUrl) });
      result.sent += 1;
      events.log('digest.sent', { accountId });
    } catch (err) {
      await database
        .delete(digestSends)
        .where(and(eq(digestSends.accountId, accountId), eq(digestSends.day, day)))
        .catch(() => {});
      result.failed.push({ accountId, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return result;
}

/** How many digests have been recorded for a day. For operators and tests. */
export async function digestSendCount(day: string, database: Database = getDb()): Promise<number> {
  const [row] = await database
    .select({ n: sql<number>`count(*)::int` })
    .from(digestSends)
    .where(eq(digestSends.day, day));
  return row?.n ?? 0;
}
