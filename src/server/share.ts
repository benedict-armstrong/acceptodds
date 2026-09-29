import { getDb, type Database } from '@/db';
import type { Listing } from '@/db/schema';
import { movePp } from '@/lib/digest';
import { DAY_MS, moves } from './follows';
import { listingView, marketView, resolveListing, resolveMarket, traderCount, type MarketView } from './views';
import { ApiError } from './api/errors';

/**
 * What the share surfaces read (issue #11): the short link `/s/<slug>`, the
 * preview images, the badge and the text share. **Reads only**, through
 * `views.ts`; prices, never values (§1.1).
 */

/** The public origin, for absolute links in previews, badges and share text. */
export function siteUrl(): string {
  return (process.env.APP_URL ?? process.env.BETTER_AUTH_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
}

/** The name on the badge. */
export function siteName(): string {
  return process.env.SITE_NAME ?? 'papermarket';
}

export interface ShareSubject {
  /** The paper, or null for a market with no listing. */
  listing: Listing | null;
  /** The main market (rank 0), or the market itself; null for a listing with no visible market. */
  main: MarketView | null;
  title: string;
  kind: string | null;
  /** The page, e.g. `/papers/<slug>`. */
  path: string;
  /** The short link, e.g. `/s/<slug>`. */
  sharePath: string;
}

/**
 * A slug (or id) as something to share: a listing first, else a market with
 * no listing. `null` when neither exists, or the market is a draft — a
 * listed market is shared as its listing.
 */
export async function shareSubject(ref: string, database: Database = getDb()): Promise<ShareSubject | null> {
  const listing = await resolveListing(ref, database).catch(notFoundAsNull);
  if (listing) {
    const view = await listingView(listing, database);
    return {
      listing,
      main: view.markets[0] ?? null,
      title: listing.title,
      kind: listing.kind ?? view.markets[0]?.market.kind ?? null,
      path: `/papers/${encodeURIComponent(listing.slug)}`,
      sharePath: `/s/${encodeURIComponent(listing.slug)}`,
    };
  }
  const market = await resolveMarket(ref, database).catch(notFoundAsNull);
  if (!market || market.status === 'draft') return null;
  if (market.listingId) {
    const parent = await resolveListing(market.listingId, database);
    return shareSubject(parent.slug, database);
  }
  return {
    listing: null,
    main: await marketView(market, database),
    title: market.question,
    kind: market.kind,
    path: `/markets/${encodeURIComponent(market.slug)}`,
    sharePath: `/s/${encodeURIComponent(market.slug)}`,
  };
}

function notFoundAsNull(err: unknown): null {
  if (err instanceof ApiError && err.status === 404) return null;
  throw err;
}

/** A move at least this big over the past week is worth a teaser. */
const TEASER_MIN_PP = 5;

/**
 * One line to make a preview worth clicking, without giving the price away:
 * the week's headline move if it is big enough, else how many traders.
 * The move is replayed exactly from the fills (`follows.moves`).
 */
export async function teaser(main: MarketView, now: Date = new Date(), database: Database = getDb()): Promise<string> {
  if (main.market.status === 'open' || main.market.status === 'closed') {
    const move = (await moves([main], now, 7 * DAY_MS, database)).get(main.market.id);
    const pp = move ? Math.round(movePp(move)) : 0;
    // ASCII signs: the preview image's fonts are Latin-only.
    if (Math.abs(pp) >= TEASER_MIN_PP) return `${pp > 0 ? '+' : '-'}${Math.abs(pp)} pp this week`;
  }
  const n = await traderCount(main.market.id, database);
  return n === 0 ? 'No trades yet' : `${n} ${n === 1 ? 'trader' : 'traders'}`;
}
