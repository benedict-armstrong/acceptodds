import { ICLR_2027 } from './iclr-2027';
import { OPENAI_MATH } from './openai-math';
import type { OutcomeColor, Venue } from './types';

export type { OutcomeColor, Venue, VenueOutcome } from './types';

/**
 * Every venue the site knows. To add one: write `venues/<venue>.ts` after an
 * existing one, add it here, and run `npm test` (`tests/unit/venues.test.ts`
 * checks its prices, colours and lengths). Its listings' `kind` must be the
 * venue's `kind` exactly.
 */
const VENUES: readonly Venue[] = [ICLR_2027, OPENAI_MATH];

const BY_KIND = new Map(VENUES.map((v) => [v.kind, v]));

/** The venue of a listing or market `kind`, or `null` for a kind with none. */
export function venue(kind: string | null | undefined): Venue | null {
  return kind ? (BY_KIND.get(kind) ?? null) : null;
}

export function venues(): readonly Venue[] {
  return VENUES;
}

/** The paper page's running head; a kind with no venue keeps the conference template's sentence. */
export function runningHead(kind: string): string {
  return venue(kind)?.runningHead ?? `Under review as a conference paper at ${kind}`;
}

/** The share line's ending after the title: the venue's, else ` @ <kind>?`, else a bare `?`. */
export function shareSuffix(kind: string | null): string {
  return venue(kind)?.shareSuffix ?? (kind ? ` @ ${kind}?` : '?');
}

/** Palette slots (`lib/headline.ts` `TIER_*`, 0 = red) by colour. */
export const COLOR_SLOT: Record<OutcomeColor, number> = { red: 0, amber: 1, green: 2, blue: 3 };
