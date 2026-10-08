import { ReadCache } from './read-cache';

/** Shared public boards/tapes; auth, rate limiting and logging stay per request. */
export const marketReads = new ReadCache();
export const MARKET_READ_TTL_MS = 1_000;
export const sparklineReads = new ReadCache();
/**
 * The home list's pages that depend on no viewer, and its venues: a scan of
 * every listing each (#12). Any market write or listing upsert drops them
 * all; the TTL only covers writers outside this process (the seed). Never
 * mutate a cached page.
 */
export const browseReads = new ReadCache(200);
export const BROWSE_READ_TTL_MS = 30_000;

/** Called only after a market write commits. In-flight older reads cannot repopulate the cache. */
export function invalidateMarketReads(marketId: string): void {
  marketReads.invalidate(marketId);
  marketReads.invalidate('refs');
  sparklineReads.invalidate(marketId);
  browseReads.clear();
}

/** Called only after a listing write commits. */
export function invalidateBrowseReads(): void {
  browseReads.clear();
}

export function clearMarketReads(): void {
  marketReads.clear();
  sparklineReads.clear();
  browseReads.clear();
}
