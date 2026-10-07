/**
 * What a listing's market looks like when its first trade makes it
 * (`server/market-start.ts`), by the listing's `kind`. A kind with no
 * template cannot be traded until a client creates its markets itself
 * (`POST /markets`).
 *
 * This and `server/jev.ts` are the only places the platform knows that a
 * listing is a paper under review: the question, the contract and the
 * question JEV is asked. Everything else still treats a listing as opaque.
 */
export interface MarketTemplate {
  question: string;
  contract: string;
  /** Best first: the headline is `1 − P(last)` (`lib/headline.ts`). */
  outcomes: string[];
  closesAt: Date;
  /** The expected field that sizes `b` (§1.3). */
  expectedTraders: number;
  /** Where the market opens when JEV gives no answer: one price per outcome, summing to 1. */
  fallbackPrices: number[];
  /** What JEV is asked: one criterion per outcome, in outcome order. */
  jev: { instructions: string; criteria: string[] };
}

/** Decisions are released on 2026-12-15; the markets close the day before. */
const ICLR_2027: MarketTemplate = {
  question: 'Will this paper get accepted to ICLR 2027',
  /**
   * Reject is every way a paper can fail to appear (#19): the client that
   * settles the market settles a withdrawal as Reject.
   */
  contract: [
    "This market settles on the venue's final decision for the paper.",
    '',
    '- **Accept**: the paper is accepted to ICLR 2027 in any form (oral, spotlight or poster).',
    '- **Reject**: the paper is rejected. This also covers a paper that is withdrawn or desk-rejected before the decision.',
  ].join('\n'),
  outcomes: ['Accept', 'Reject'],
  closesAt: new Date('2026-12-14T00:00:00Z'),
  expectedTraders: 6,
  // The previous oral, spotlight and poster rates combined into about a 33% acceptance rate.
  fallbackPrices: [0.33, 0.67],
  jev: {
    // The prior and the reviewing guidelines, so the answer starts from the base rate and moves only on the
    // paper's merits as reviewers judge them, not on whether it reads like a paper.
    instructions: [
      'This paper is under review at ICLR 2027. Predict its final decision.',
      '',
      'Start from the base rate: about 33% of ICLR submissions are accepted (oral, spotlight and poster ' +
        'combined), so most papers are rejected, and a competent, well-written paper is not by itself ' +
        'above the base rate. Move away from it only as far as the paper gives you reason to.',
      '',
      'Judge it as ICLR reviewers and area chairs do, by its guidelines for a good paper:',
      '- Significance and interest: does it address a problem the ICLR community cares about, and would ' +
        'people build on it?',
      '- Novelty: is the idea, method or finding new, or an incremental variation on prior work?',
      '- Soundness: do the claims follow from the theory and experiments, with appropriate baselines, ' +
        'ablations and evaluation?',
      '- Clarity: is it clearly written, with its contributions stated and supported?',
      '- Reproducibility: are the methods, data and settings described well enough to reproduce?',
      '',
      'Weigh the paper as a whole, as a meta-review would: a clear, significant contribution outweighs ' +
        'minor flaws, while a serious flaw in soundness or a lack of novelty usually means rejection.',
    ].join('\n'),
    criteria: ['accepted in any form (oral, spotlight or poster)', 'rejected, withdrawn or desk-rejected'],
  },
};

const TEMPLATES: Record<string, MarketTemplate> = { 'ICLR 2027': ICLR_2027 };

export function marketTemplate(kind: string | null): MarketTemplate | null {
  return kind === null ? null : (TEMPLATES[kind] ?? null);
}

/** The kind's template while a first trade may still make a market from it: before it closes. */
export function openMarketTemplate(kind: string | null): MarketTemplate | null {
  const t = marketTemplate(kind);
  return t && t.closesAt.getTime() > Date.now() ? t : null;
}

/** Every template, for sizing the house treasury (`db/seed.ts`). */
export function marketTemplates(): MarketTemplate[] {
  return Object.values(TEMPLATES);
}
