/**
 * The likelihood colour of a binary market, for the UI. Client-safe.
 *
 * Read from the first outcome (ordinal 0) — by convention the "yes" side,
 * which for a paper's acceptance market is "accepted". The venue attaches no
 * meaning to it; this is display only, and it colours text, edge bars and chips with
 * the `accept` / `reject` / `toss-up` tokens in `app/globals.css`.
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

interface MarketLike {
  status: string;
  resolvedOutcomeId: string | null;
  outcomes: { id: string; ordinal: number; price: number }[];
}

/**
 * A binary market's likelihood: its first outcome's price, or its result once
 * settled. `null` for anything else (more than two outcomes, a void market),
 * which is then shown uncoloured.
 */
export function marketLikelihood(m: MarketLike): Likelihood | null {
  if (m.outcomes.length !== 2) return null;
  const yes = m.outcomes.find((o) => o.ordinal === 0);
  if (!yes) return null;
  if (m.status === 'void') return null;
  if (m.status === 'settled') return m.resolvedOutcomeId === yes.id ? 'accept' : 'reject';
  return likelihood(yes.price);
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
