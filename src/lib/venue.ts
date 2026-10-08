/**
 * The venue shown first: the home page opens on it, and onboarding asks about
 * its papers. Opaque to the platform: it is a market `kind` string.
 */
export function defaultMarketKind(): string {
  return process.env.DEFAULT_MARKET_KIND ?? 'ICLR 2027';
}

/**
 * The venue this browser last picked, on the home page or in `/welcome`,
 * where it is the default venue to search. A preference, not a credential.
 */
export const VENUE_COOKIE = 'venue';

/** Client only: remember `kind` as this browser's venue, for a year. */
export function rememberVenue(kind: string): void {
  document.cookie = `${VENUE_COOKIE}=${encodeURIComponent(kind)}; path=/; max-age=31536000; samesite=lax`;
}
