import { marketHeadline, type MarketLike } from '@/lib/headline';

type Live = MarketLike & { orderCount: number };

/** Whether `MarketLive` shows the venue standing (its Figure 2): only once traded, while trading, with a field to place it in. */
export function showsVenueStanding(market: Live, hasVenue: boolean): boolean {
  return hasVenue && market.orderCount > 0 && market.status !== 'settled' && marketHeadline(market) !== null;
}

/**
 * How many figures `MarketLive` sets: the price chart once the market has a
 * fill, then the venue standing. A page numbers its own figures after them.
 * Not a client module, so the server can call it too.
 */
export function marketLiveFigures(market: Live, hasVenue: boolean): number {
  return (market.orderCount > 0 ? 1 : 0) + (showsVenueStanding(market, hasVenue) ? 1 : 0);
}
