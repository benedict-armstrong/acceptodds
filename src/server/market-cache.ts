import { ReadCache } from './read-cache';

/** Shared public boards/tapes; auth, rate limiting and logging stay per request. */
export const marketReads = new ReadCache();
export const MARKET_READ_TTL_MS = 1_000;
export const sparklineReads = new ReadCache();
/**
 * The home list's pages that depend on no viewer, and its venues: a scan of
 * every listing each (#12). A listing upsert drops them all. A market write
 * (a fill, an opening, a settlement) leaves them at most
 * `BROWSE_STALE_AFTER_WRITE_MS` to live: at a fill or an opening every few
 * seconds, dropping them on each made nearly every home page a cache miss,
 * and a list a few seconds behind the tape is fine. The TTL only covers
 * writers outside this process (the seed). Never mutate a cached page.
 */
export const browseReads = new ReadCache(200);
export const BROWSE_READ_TTL_MS = 30_000;
/** 0 (the tests' setting, `tests/setup-env.ts`) drops them at once, as a listing upsert does. */
const BROWSE_STALE_AFTER_WRITE_MS = Number(process.env.BROWSE_STALE_AFTER_WRITE_MS ?? 5_000);

/** `views.traderInstitutions`: every account scanned, for the board picker and the home page's strip. */
export const institutionReads = new ReadCache(1);
export const INSTITUTION_READ_TTL_MS = 60_000;

/** Called only after a market write commits. In-flight older reads cannot repopulate the cache. */
export function invalidateMarketReads(marketId: string): void {
  marketReads.invalidate(marketId);
  marketReads.invalidate('refs');
  sparklineReads.invalidate(marketId);
  browseReads.expireWithin(BROWSE_STALE_AFTER_WRITE_MS);
}

/** Called only after a listing write commits. */
export function invalidateBrowseReads(): void {
  browseReads.clear();
}

export function clearMarketReads(): void {
  marketReads.clear();
  sparklineReads.clear();
  browseReads.clear();
  institutionReads.clear();
}
