/**
 * Class lists for the patterns the UI repeats. Each one is a complete look:
 * callers may add utilities for properties it leaves alone, never override
 * one it sets, because Tailwind resolves a conflict by stylesheet order, not
 * by class order. A variant is a parameter instead.
 */

/** Headings are set like an ICLR paper's: serif small caps, not bold. */
const sectionLook = 'font-serif text-lg leading-snug font-normal [font-variant-caps:small-caps] text-ink';
const subsectionLook = 'font-serif text-[15px] leading-snug font-normal [font-variant-caps:small-caps] text-ink';

/**
 * A page's section, numbered in page order like a paper's \section. The
 * numbers are CSS counters (`sec-num`, `globals.css`), not data.
 */
const section = `${sectionLook} sec-num`;

/** A section's subsection, numbered "1.2" under the last section. */
const subsection = `${subsectionLook} subsec-num`;

export const ui = {
  /** The bare section and subsection headings, for a place that sets its own spacing. */
  section,
  subsection,
  /** An unnumbered subsection heading, for a box or popover beside the page's flow. */
  boxHeading: `mb-2 ${subsectionLook}`,
  /** A run-in heading, set in a line of other text: who wrote a comment, as OpenReview heads one. */
  runIn: subsectionLook,
  page: 'mx-auto max-w-[880px] px-6 pt-3 pb-15 narrow:px-4',
  groupHeading: `mt-10 mb-2 ${section}`,
  /** An unnumbered section, for back matter such as References. */
  backHeading: `mt-10 mb-2 ${sectionLook}`,
  sectionHeading: `mb-3 ${subsection}`,
  empty: 'py-7.5 italic text-muted',
  /** A figure's caption, under it: "<b>Figure N.</b> …", numbered by hand in page order. */
  caption: 'mt-1 text-[13px] text-subtle',
  /** A table's `<caption>`, above it as in a paper: "<b>Table N.</b> …". */
  tableCaption: 'mb-1 text-left font-serif text-[13px] text-subtle',
  fine: 'mt-1.5 text-xs text-faint',
  mono: 'font-mono text-[13px]',
  badge: 'ml-1 rounded-[3px] border border-[#bbb] px-1 align-[1px] font-sans text-[11px] text-muted',
  box: 'border border-frame bg-card p-3.5 font-sans text-sm',
  /**
   * A text field. 16px on a phone: iOS Safari zooms the page into any field
   * set smaller when it is focused. Every text input and textarea carries
   * `narrow:text-base` for the same reason.
   */
  input: 'mb-2 w-full border border-rule bg-white p-1.5 font-sans text-sm leading-[normal] narrow:text-base',
  /** A label on the left, a value on the right. */
  kv: 'flex justify-between gap-3 tabular-nums [&>span:first-child]:text-muted',
  /**
   * Tables are set like a LaTeX paper's with booktabs: a heavy rule above
   * (\toprule), a light one under the header (\midrule), a heavy one below
   * (\bottomrule), and nothing vertical or between rows. The caption, a
   * `<caption>`, sits above the top rule.
   */
  th: (numeric = false) =>
    `border-b border-ink py-1.5 pr-2 font-serif text-sm font-semibold text-ink ${numeric ? 'text-right' : 'text-left'}`,
  td: 'py-[5px] pr-2',
  num: 'text-right font-mono text-[13px]',
  /** A body row is highlighted on hover, as the home list's rows are. */
  table: 'mt-3 w-full border-collapse border-y-[1.5px] border-ink [&>tbody>tr:hover]:bg-highlight/50',
  /** Around a table, so one too wide for a phone scrolls sideways rather than the page. */
  tableScroll: 'overflow-x-auto',
  /** A table note's mark on a column heading, "Net worth<sup>a</sup>": an italic letter, as threeparttable sets it. */
  mark: 'ml-px font-serif text-[10px] font-normal italic',
  /**
   * A popover's trigger that picks something (the leaderboard's board, the navbar's venue), marked as a field
   * the way the trade box's stake is: a dashed rule, solid accent on hover, focus or while open. Sets no colour.
   */
  picker:
    'cursor-pointer border-0 border-b-2 border-dashed border-rule-strong outline-none hover:border-solid hover:border-accent focus-visible:border-solid focus-visible:border-accent data-[state=open]:border-solid data-[state=open]:border-accent',
  /** A table row from a venue other than the navbar's (§1.8): still there, but set back; full again on hover. */
  otherVenue: 'opacity-45 transition-opacity hover:opacity-100',
  /** The selected link in a row of filter or tab links. */
  on: 'font-semibold text-ink',
  /** A P&L's colour: profit green, loss red, zero plain ink. */
  pnl: (micro: string | bigint) => {
    const v = typeof micro === 'bigint' ? micro : BigInt(micro);
    return v > 0n ? 'text-up' : v < 0n ? 'text-down' : 'text-ink';
  },
  note: (ok: boolean) => `mt-2 text-[13px] ${ok ? 'text-up' : 'text-down'}`,
  /** A button that reads as an accent link: an inline action, not a call to action. */
  /** An external link boxed as hyperref boxes a `\url{}`: typewriter, ink, a cyan frame. */
  hyperref:
    'border border-hyperref px-px font-mono text-[0.9em] break-all text-ink box-decoration-clone hover:no-underline',
  /** The home page's search field and its button; `/welcome`'s paper search uses the field alone. */
  searchInput:
    'min-w-0 flex-1 border border-rule bg-card px-2 py-1.5 font-sans text-sm leading-[normal] placeholder:text-faint narrow:text-base focus:border-frame focus:outline-none',
  searchBtn: 'cursor-pointer border border-rule bg-rule-soft px-3.5 font-sans text-sm font-semibold text-ink',
  linkBtn: 'cursor-pointer text-accent hover:underline disabled:cursor-default disabled:opacity-50',
  /** `inline`: sized to its label, not the full width. `flush`: no top margin, and flows in text (a table cell's action). */
  /** `fill`: a background class in place of the accent (e.g. an outcome's `TIER_BG`). */
  btn: ({ ghost = false, inline = false, flush = false, fill = '' } = {}) =>
    `${flush ? 'inline-block' : 'mt-2 block'} cursor-pointer text-center font-sans text-sm leading-[normal] font-semibold hover:no-underline disabled:cursor-default disabled:opacity-50 ${
      ghost ? 'bg-rule-soft text-ink' : `${fill || 'bg-accent'} text-white`
    } ${inline ? 'px-4 py-1.5' : 'w-full p-2'}`,
};
