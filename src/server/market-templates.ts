import { venue, venues, type Venue } from '@/venues';

/**
 * What a listing's market looks like when it is opened on demand
 * (`server/market-start.ts`), by the listing's `kind`: its venue's market
 * (`venues/`), in the shape the engine and JEV take. A kind with no venue
 * cannot be traded until a client creates its markets itself
 * (`POST /markets`).
 */
export interface MarketTemplate {
  question: string;
  contract: string;
  /** Best first: the headline is `1 − P(last)` (`lib/headline.ts`). */
  outcomes: string[];
  closesAt: Date;
  /** The expected field that sizes `b` (§1.3). */
  expectedTraders: number;
  /** Where the market opens when JEV is not asked or gives no answer: one price per outcome, summing to 1. */
  fallbackPrices: number[];
  /**
   * What JEV is asked: one criterion per outcome, in outcome order; `null`: no model call. `typical` is
   * JEV's own average answer, read against the prior (`jev.calibrated`).
   */
  jev: { instructions: string; criteria: string[]; typical: number[] } | null;
  /** Opened when the listing is posted (`POST /listings`), not on demand. */
  opensWithListing: boolean;
}

function templateOf(v: Venue): MarketTemplate {
  const m = v.market;
  return {
    question: m.question,
    contract: m.contract,
    outcomes: m.outcomes.map((o) => o.label),
    closesAt: m.closesAt,
    expectedTraders: m.expectedTraders,
    fallbackPrices: m.outcomes.map((o) => o.openingPrice),
    jev: m.jev,
    opensWithListing: m.opensWithListing,
  };
}

export function marketTemplate(kind: string | null): MarketTemplate | null {
  const v = venue(kind);
  return v && templateOf(v);
}

/** The kind's template while a first trade may still make a market from it: before it closes. */
export function openMarketTemplate(kind: string | null): MarketTemplate | null {
  const t = marketTemplate(kind);
  return t && t.closesAt.getTime() > Date.now() ? t : null;
}

/** Every template, for sizing the house treasury (`db/seed.ts`). */
export function marketTemplates(): MarketTemplate[] {
  return venues().map(templateOf);
}
