type Board = { status: string; orderCount: number; closesAt: string };

/** Settled boards cannot change; quiet markets need fewer origin requests. */
export function marketPollInterval(market: Board, now = Date.now()): number {
  if (market.status === 'settled' || market.status === 'void') return 0;
  if (market.status !== 'open' || new Date(market.closesAt).getTime() <= now) return 30_000;
  return market.orderCount === 0 ? 15_000 : 5_000;
}

/** No fills can arrive after trading closes; the board still polls for settlement. */
export function tapePollInterval(market: Board, now = Date.now()): number {
  if (market.status !== 'open' || new Date(market.closesAt).getTime() <= now) return 0;
  return marketPollInterval(market, now);
}
