/**
 * A market's **headline**: one probability that stands for the whole market in
 * lists, badges, previews, follows and the digest. Pure and client-safe.
 *
 * Convention (issue #11): outcomes are ordered **best first, worst last**. A
 * paper's market is `oral, spotlight, poster, reject`; a binary one is
 * `YES, NO`. The headline is `1 − P(last outcome)`: for `[YES, NO]` exactly
 * P(YES), as before, and for a paper P(accepted in any form). The platform
 * attaches no meaning to the labels; the order is the whole contract, and
 * `../research` creates outcomes in it.
 *
 * A price is a probability, not a value (§1.1): nothing here marks a position.
 */

/** Which outcome the headline reads, and whether it is that outcome's complement. */
export interface HeadlineOf {
  ordinal: number;
  /** True when the headline is `1 − P(ordinal)` rather than `P(ordinal)`. */
  negated: boolean;
}

/**
 * Binary: the first outcome, as is. More: the complement of the last. The two
 * agree on a binary market (1 − P(NO) = P(YES)); binary keeps the first
 * outcome so an API client sees the same outcome it always has.
 */
export function headlineOf(outcomes: number): HeadlineOf {
  return outcomes <= 2 ? { ordinal: 0, negated: false } : { ordinal: outcomes - 1, negated: true };
}

/** The headline of a price vector indexed by ordinal. */
export function headlinePrice(prices: readonly number[]): number {
  const h = headlineOf(prices.length);
  const p = prices[h.ordinal];
  return h.negated ? 1 - p : p;
}

/** The headline before any trade: every outcome at 1/n. */
export function openingHeadline(outcomes: number): number {
  return headlinePrice(Array.from({ length: outcomes }, () => 1 / outcomes));
}

export interface MarketLike {
  status: string;
  resolvedOutcomeId: string | null;
  outcomes: { id: string; ordinal: number; price: number }[];
}

/**
 * A market's headline now: from its prices while it trades, 1 or 0 by its
 * result once settled, `null` when void or with fewer than two outcomes.
 */
export function marketHeadline(m: MarketLike): number | null {
  if (m.outcomes.length < 2 || m.status === 'void') return null;
  const byOrdinal = [...m.outcomes].sort((a, b) => a.ordinal - b.ordinal);
  if (m.status === 'settled') {
    return headlinePrice(byOrdinal.map((o) => (o.id === m.resolvedOutcomeId ? 1 : 0)));
  }
  return headlinePrice(byOrdinal.map((o) => o.price));
}

/**
 * What the headline is called. On a paper (a listing's market) the UI calls
 * it "accept" — the one place the paper convention is spelled out; elsewhere
 * the first outcome's label, or "not <last>".
 */
export function headlineLabel(labels: readonly string[], paper = false): string {
  if (paper) return 'accept';
  return labels.length <= 2 ? (labels[0] ?? '') : `not ${labels[labels.length - 1]}`;
}

// ---------------------------------------------------------------------------
// the outcome bar: tiers, squares
// ---------------------------------------------------------------------------

/** The most outcomes the bar, badge and share text draw. More get no bar. */
export const MAX_BAR_OUTCOMES = 4;

/**
 * An outcome's tier, 1 = worst: the last ordinal is tier 1, the first is
 * tier n. So a paper's `reject` is 1 and `oral` 4, and a binary market's
 * `NO` is 1 and `YES` 2 — but see `tierColor`, which skips a binary market
 * to the good end.
 */
export function tierOf(ordinal: number, outcomes: number): number {
  return outcomes - ordinal;
}

/** Emoji per tier (1 = worst): red, amber, green, blue. */
const SQUARES = ['🟥', '🟨', '🟩', '🟦'] as const;

/**
 * The palette slot (0–3) for an outcome: worst is always red; two outcomes
 * are red/green, three red/amber/green, four red/amber/green/blue.
 */
export function paletteSlot(ordinal: number, outcomes: number): number {
  const tier = tierOf(ordinal, outcomes);
  if (outcomes === 2) return tier === 1 ? 0 : 2;
  return tier - 1;
}

export function squareOf(ordinal: number, outcomes: number): string {
  return SQUARES[paletteSlot(ordinal, outcomes)];
}

/** Tailwind class lists per palette slot, written whole so Tailwind finds them. */
export const TIER_BG = ['bg-tier-1', 'bg-tier-2', 'bg-tier-3', 'bg-tier-4'] as const;
/**
 * Outcome controls (the trade box), per palette slot: the bar's colours, but
 * red and green as the stronger `down`/`up`, since a button is a small area.
 */
export const TIER_STRONG_BG = ['bg-down', 'bg-tier-2', 'bg-up', 'bg-tier-4'] as const;
/** A selected outcome's control, per palette slot: filled in `TIER_STRONG_BG`. */
export const TIER_FILL = [
  'border-down bg-down text-white',
  'border-tier-2 bg-tier-2 text-white',
  'border-up bg-up text-white',
  'border-tier-4 bg-tier-4 text-white',
] as const;
/** The same colours as hex, for SVG and image rendering (`app/globals.css` `--color-tier-*`). */
export const TIER_HEX = ['#a24a3f', '#c49a2c', '#3d7a4f', '#3f6a9a'] as const;

/** Ordinals in the bar's order: worst on the left. */
export function barOrder(outcomes: number): number[] {
  return Array.from({ length: outcomes }, (_, i) => outcomes - 1 - i);
}

/** An outcome below this price gets no square: honest over pretty. */
export const MIN_SQUARE_PRICE = 0.05;

/**
 * Split `squares` squares between outcomes by price: largest remainder, so the
 * counts always sum to `squares` and each is within one of its exact share.
 * Outcomes under `MIN_SQUARE_PRICE` get none, and the rest share all squares
 * in proportion. Ties in the remainder go to the higher price, then the lower
 * ordinal. Indexed by ordinal.
 */
export function squareCounts(prices: readonly number[], squares = 10): number[] {
  const eligible = prices.map((p) => p >= MIN_SQUARE_PRICE);
  const total = prices.reduce((s, p, i) => (eligible[i] ? s + p : s), 0);
  const counts = prices.map(() => 0);
  if (total <= 0) return counts;
  const quotas = prices.map((p, i) => (eligible[i] ? (p / total) * squares : 0));
  let left = squares;
  quotas.forEach((q, i) => {
    counts[i] = Math.floor(q);
    left -= counts[i];
  });
  const order = prices
    .map((_, i) => i)
    .filter((i) => eligible[i])
    .sort(
      (a, b) =>
        quotas[b] - Math.floor(quotas[b]) - (quotas[a] - Math.floor(quotas[a])) || prices[b] - prices[a] || a - b,
    );
  for (let k = 0; k < left; k += 1) counts[order[k % order.length]] += 1;
  return counts;
}

/** The emoji row, worst on the left, e.g. `🟥🟥🟥🟥🟨🟨🟨🟩🟩🟦`. */
export function squareRow(prices: readonly number[], squares = 10): string {
  const counts = squareCounts(prices, squares);
  return barOrder(prices.length)
    .map((i) => squareOf(i, prices.length).repeat(counts[i]))
    .join('');
}

// ---------------------------------------------------------------------------
// the text share
// ---------------------------------------------------------------------------

/** The title line (`<title> @ <kind>?`) is kept to about two lines on a phone. */
export const SHARE_TITLE_MAX = 50;

/**
 * `<title> @ <kind>?`, at most `max` characters: the title is cut at a word
 * boundary and gets `…`; `@ <kind>?` is always kept whole. TeX `$` delimiters
 * are dropped, since a chat app shows them raw.
 */
export function shareTitleLine(title: string, kind: string | null, max = SHARE_TITLE_MAX): string {
  const { head, suffix } = shareTitleParts(title, kind, max);
  return head + suffix;
}

/** `shareTitleLine` in two parts, the (cut) title and ` @ <kind>?`, for a card that sets them apart. */
export function shareTitleParts(
  title: string,
  kind: string | null,
  max = SHARE_TITLE_MAX,
): { head: string; suffix: string } {
  const suffix = kind ? ` @ ${kind}?` : '?';
  const clean = title.replace(/\$/g, '').replace(/\s+/g, ' ').trim();
  const room = Math.max(8, max - suffix.length);
  if ([...clean].length <= room) return { head: clean, suffix };
  const chars = [...clean].slice(0, room - 1).join('');
  const cut = chars.lastIndexOf(' ');
  const head = (cut >= room / 2 ? chars.slice(0, cut) : chars).replace(/[\s,.:;–—-]+$/, '');
  return { head: `${head}…`, suffix };
}

/**
 * Left edges for labels of the given widths, each centred on its `centers`
 * entry where it can be, pushed apart by at least `gap` and kept inside
 * `[0, total]`. Centres are in order, left to right. When the labels cannot
 * all fit, the right edge wins and the leftmost ones overlap.
 */
export function placeLabels(
  centers: readonly number[],
  widths: readonly number[],
  total: number,
  gap: number,
): number[] {
  const left = centers.map((c, i) => c - widths[i] / 2);
  for (let i = 0; i < left.length; i++) {
    left[i] = Math.max(left[i], i === 0 ? 0 : left[i - 1] + widths[i - 1] + gap);
  }
  for (let i = left.length - 1; i >= 0; i--) {
    left[i] = Math.min(left[i], i === left.length - 1 ? total - widths[i] : left[i + 1] - gap - widths[i]);
  }
  return left;
}

export interface ShareInput {
  title: string;
  kind: string | null;
  /** Absolute URL of the share link, e.g. `https://acceptodds.com/s/slug`. */
  url: string;
  status: string;
  /** Prices indexed by ordinal. */
  prices: readonly number[];
  /** The year of the entry, the sharer's own. */
  year: number;
}

/** A BibTeX field value: `& % # _ \ { }` are escaped so the entry compiles. */
function bibEscape(text: string): string {
  return text.replace(/[\\&%#_{}]/g, (c) => (c === '\\' ? '\\textbackslash{}' : `\\${c}`));
}

/**
 * The text a share copies (issue #33): a BibTeX `@misc` entry, keyed by the
 * slug, whose title is the usual `<title> @ <kind>?` line, `howpublished` the
 * link and `note` the outcome bar. The bar (prices, never a value, §1.1) is
 * there only while the market is open or closed and has 2–4 outcomes.
 */
export function shareText(s: ShareInput): string {
  const key =
    decodeURIComponent(
      s.url
        .replace(/[?#].*$/, '')
        .split('/')
        .pop() ?? '',
    ) || 'market';
  const fields: [string, string][] = [
    ['title', bibEscape(shareTitleLine(s.title, s.kind, 120))],
    ['howpublished', `\\url{${s.url}}`],
  ];
  const barred =
    (s.status === 'open' || s.status === 'closed') && s.prices.length >= 2 && s.prices.length <= MAX_BAR_OUTCOMES;
  if (barred) fields.push(['note', squareRow(s.prices)]);
  fields.push(['year', String(s.year)]);
  const width = Math.max(...fields.map(([k]) => k.length));
  const body = fields.map(([k, v]) => `  ${k.padEnd(width)} = {${v}}`).join(',\n');
  return `@misc{${key.replace(/[^\w.:-]/g, '-')},\n${body}\n}`;
}
