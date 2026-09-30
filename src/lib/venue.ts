/**
 * The venue shown first: the home page opens on it, and onboarding asks about
 * its papers. Opaque to the platform: it is a market `kind` string.
 */
export function defaultMarketKind(): string {
  return process.env.DEFAULT_MARKET_KIND ?? 'ICLR 2027';
}
