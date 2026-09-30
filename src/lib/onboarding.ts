/**
 * Where the onboarding confirmation (link or code) returns to: `/welcome`,
 * which then sees the new session and its pending bet.
 */
export const WELCOME_FINISH = '/welcome?step=finish';

/**
 * Set once `/welcome` has been shown in this browser. Until then, `/signin`
 * and `/signup` send the visitor there first; its intro links back to both.
 * A preference, not a credential: it grants nothing.
 */
export const WELCOMED_COOKIE = 'welcomed';

/** `/welcome`, keeping where sign-in or sign-up would have returned to. */
export function welcomeHref(next: string): string {
  return next === '/' ? '/welcome' : `/welcome?next=${encodeURIComponent(next)}`;
}

/** A bet a visitor chose on a market's own page, carried into onboarding. */
export interface ChosenBet {
  marketId: string;
  outcomeId: string;
  stakeMicro: bigint;
  /** The market's `orderCount` on the board it was chosen from. */
  seenOrderCount: number;
}

/**
 * `/welcome` for a visitor who already chose a bet on a market's page: the
 * flow starts after the paper and bet steps, at the comment.
 */
export function welcomeBetHref(bet: ChosenBet): string {
  const q = new URLSearchParams({
    step: 'comment',
    market: bet.marketId,
    outcome: bet.outcomeId,
    stake: bet.stakeMicro.toString(),
    seen: String(bet.seenOrderCount),
  });
  return `/welcome?${q}`;
}

/**
 * The bet in `welcomeBetHref`'s parameters, or `null` when any is missing
 * or malformed. Only the shape: the page still checks it against the market.
 */
export function parseChosenBet(params: {
  market?: string;
  outcome?: string;
  stake?: string;
  seen?: string;
}): ChosenBet | null {
  const { market, outcome, stake, seen } = params;
  if (!market || !outcome || !stake || !/^[1-9]\d{0,18}$/.test(stake) || !seen || !/^\d{1,9}$/.test(seen)) return null;
  return { marketId: market, outcomeId: outcome, stakeMicro: BigInt(stake), seenOrderCount: Number(seen) };
}
