import { ReadCache } from './read-cache';

/** Shared public boards/tapes; auth, rate limiting and logging stay per request. */
export const marketReads = new ReadCache();
export const MARKET_READ_TTL_MS = 1_000;
export const sparklineReads = new ReadCache();

/** Called only after a market write commits. In-flight older reads cannot repopulate the cache. */
export function invalidateMarketReads(marketId: string): void {
  marketReads.invalidate(marketId);
  marketReads.invalidate('refs');
  sparklineReads.invalidate(marketId);
}

export function clearMarketReads(): void {
  marketReads.clear();
  sparklineReads.clear();
}
