/**
 * A venue: everything that differs between the kinds of listing the site
 * trades, in one file per venue (`venues/<venue>.ts`), registered in
 * `venues/index.ts`. A venue is a listing `kind` with a market template and
 * the words the site uses for it.
 *
 * The venue files, `server/market-templates.ts` and `server/jev.ts` are the
 * only places the platform knows what a listing is (a paper under review, a
 * manuscript awaiting verification). Everything else reads its wording from
 * here by `kind`, and never branches on a kind's name.
 *
 * Client-safe: plain data, no server imports.
 */

/** An outcome's colour on the bar, the trade box and the charts: the `tier-*` palette. */
export type OutcomeColor = 'red' | 'amber' | 'green' | 'blue';

export interface VenueOutcome {
  label: string;
  color: OutcomeColor;
  /**
   * Where the market opens: always, for a venue that asks JEV nothing; else
   * when JEV gives no answer. The outcomes' prices sum to 1.
   */
  openingPrice: number;
}

export interface Venue {
  /** The listings' `kind`, as `../research` sends it. */
  kind: string;

  // --- the home page and its link preview --------------------------------

  /** The home page's title after the wordmark, e.g. "Which papers will get accepted at ICLR 2027?". */
  homeTitle: string;
  /** The home link preview's title, short enough for the card: "Which papers will get accepted?". */
  cardTitle: string;
  /** One line on what the site is for this venue: "A prediction market on peer review". No full stop. */
  lede: string;
  /** What each listing's market asks, in the home abstract: "Each paper has a market on …". */
  marketOn: string;
  /** When markets settle, in the home abstract: "every market settles when …". */
  settlesWhen: string;
  /** Who the site has no connection to, named in the home abstract. */
  unaffiliated: string[];
  /** The card's example question around the hidden title: "Will ▒▒ be accepted @ ICLR 2027?". */
  cardQuestion: { predicate: string; suffix: string };

  // --- a listing's page and its shares ------------------------------------

  /** The paper page's running head: "Under review as a conference paper at ICLR 2027". */
  runningHead: string;
  /** What the headline (`1 − P(last)`, `lib/headline.ts`) is called: "accept", "verified". */
  headlineLabel: string;
  /** What the headline is the chance of, on the paper page: "est. 42% chance <this paper gets accepted at ICLR 2027>.". */
  chanceOf: string;
  /** The home page's name for the headline sort: "acceptance". */
  headlineSort: string;
  /** The share line after the title (`lib/headline.ts` `shareTitleLine`): " @ ICLR 2027?". Latin only (OG image). */
  shareSuffix: string;

  // --- the market a listing opens on demand (`server/market-start.ts`) ---

  market: {
    question: string;
    /** Markdown, shown on the market's page under "Contract". */
    contract: string;
    /** Best first, worst last: the headline is `1 − P(last)`. */
    outcomes: VenueOutcome[];
    /** Trading stops here, and no market opens after it. */
    closesAt: Date;
    /** The expected field that sizes `b` (§1.3). */
    expectedTraders: number;
    /**
     * What JEV is asked about the listing, with one criterion per outcome in
     * outcome order; `null`: no model call, the market opens at the outcomes'
     * `openingPrice`. `typical` is JEV's own average answer over the venue's
     * listings, one price per outcome summing to 1, measured, never the
     * prior: its answer is read relative to it (`jev.calibrated`), so a
     * typical listing opens at the `openingPrice`s.
     */
    jev: { instructions: string; criteria: string[]; typical: number[] } | null;
    /**
     * `true`: a listing's market opens when `../research` posts the listing
     * (`POST /listings`), opened by nobody. `false`: it opens on demand, when
     * someone asks for it (the paper page's "Open Market", a first order).
     */
    opensWithListing: boolean;
  };
}
