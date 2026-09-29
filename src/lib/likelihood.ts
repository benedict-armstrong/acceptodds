import { marketHeadline, type MarketLike } from './headline';

/**
 * The likelihood colour of a market, for the UI. Client-safe.
 *
 * Read from the market's headline (`lib/headline.ts`): the first outcome of a
 * binary market, `1 − P(last)` of a larger one — for a paper, the chance it is
 * accepted in any form. The venue attaches no meaning to it; this is display
 * only, and it colours text, edge bars and chips with the `accept` / `reject`
 * / `toss-up` tokens in `app/globals.css`.
 */

export type Likelihood = 'accept' | 'reject' | 'toss-up';

/** At or above: likely yes. At or below `REJECT_AT`: likely no. */
export const ACCEPT_AT = 0.65;
export const REJECT_AT = 0.35;

export function likelihood(p: number): Likelihood {
  if (p >= ACCEPT_AT) return 'accept';
  if (p <= REJECT_AT) return 'reject';
  return 'toss-up';
}

/**
 * A market's likelihood: its headline price, or its result once settled.
 * `null` for a void market, which is then shown uncoloured.
 */
export function marketLikelihood(m: MarketLike): Likelihood | null {
  const h = marketHeadline(m);
  return h === null ? null : likelihood(h);
}

/**
 * Class lists per likelihood. Written out whole so Tailwind finds them.
 * `text`: the price. `bar`: the background of a thin bar at a row's left
 * edge. `chip`: a soft-tinted price.
 */
export const LIKELIHOOD_CLASS: Record<Likelihood | 'none', { text: string; bar: string; chip: string }> = {
  accept: { text: 'text-accept', bar: 'bg-accept', chip: 'bg-accept-soft text-accept' },
  reject: { text: 'text-reject', bar: 'bg-reject', chip: 'bg-reject-soft text-reject' },
  'toss-up': { text: 'text-ink', bar: 'bg-toss-up', chip: 'bg-highlight text-ink' },
  none: { text: 'text-ink', bar: 'bg-transparent', chip: 'bg-highlight text-ink' },
};

export function likelihoodClass(l: Likelihood | null) {
  return LIKELIHOOD_CLASS[l ?? 'none'];
}
