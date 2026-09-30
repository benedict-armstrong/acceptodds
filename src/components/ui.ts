/**
 * Class lists for the patterns the UI repeats. Each one is a complete look:
 * callers may add utilities for properties it leaves alone, never override
 * one it sets, because Tailwind resolves a conflict by stylesheet order, not
 * by class order. A variant is a parameter instead.
 */

/** The small-caps sans label over a stat, field or table column. */
const label = 'font-sans text-xs font-semibold uppercase tracking-[.06em] text-muted';

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
  /** The bare label, for a place that sets its own spacing. */
  label,
  /** The bare section and subsection headings, for a place that sets its own spacing. */
  section,
  subsection,
  /** An unnumbered subsection heading, for a box or popover beside the page's flow. */
  boxHeading: `mb-2 ${subsectionLook}`,
  page: 'mx-auto max-w-[880px] px-6 pt-3 pb-15',
  groupHeading: `mt-7 mb-1.5 ${section}`,
  sectionHeading: `mb-2 ${subsection}`,
  empty: 'py-7.5 italic text-muted',
  caption: 'mt-1 text-[13px] text-subtle',
  fine: 'mt-1.5 text-xs text-faint',
  mono: 'font-mono text-[13px]',
  badge: 'ml-1 rounded-[3px] border border-[#bbb] px-1 align-[1px] font-sans text-[11px] text-muted',
  box: 'border border-frame bg-card p-3.5 font-sans text-sm',
  input: 'mb-2 w-full border border-rule bg-white p-1.5 font-sans text-sm leading-[normal]',
  /** A label on the left, a value on the right. */
  kv: 'flex justify-between gap-3 tabular-nums [&>span:first-child]:text-muted',
  th: (numeric = false) =>
    `border-b border-rule py-1.5 pr-2 font-semibold uppercase tracking-[.05em] text-muted ${
      numeric ? 'text-right font-mono text-[13px]' : 'text-left font-sans text-xs'
    }`,
  td: 'border-b border-dotted border-rule-strong py-[7px] pr-2',
  num: 'text-right font-mono text-[13px]',
  table: 'mt-3 w-full border-collapse',
  /** The selected link in a row of filter or tab links. */
  on: 'font-semibold text-ink',
  /** A P&L's colour: profit green, loss red, zero plain ink. */
  pnl: (micro: string | bigint) => {
    const v = typeof micro === 'bigint' ? micro : BigInt(micro);
    return v > 0n ? 'text-up' : v < 0n ? 'text-down' : 'text-ink';
  },
  note: (ok: boolean) => `mt-2 text-[13px] ${ok ? 'text-up' : 'text-down'}`,
  /** A button that reads as an accent link: an inline action, not a call to action. */
  linkBtn: 'cursor-pointer text-accent hover:underline disabled:cursor-default disabled:opacity-50',
  /** `inline`: sized to its label, not the full width. `flush`: no top margin, and flows in text (a table cell's action). */
  btn: ({ ghost = false, inline = false, flush = false } = {}) =>
    `${flush ? 'inline-block' : 'mt-2 block'} cursor-pointer text-center font-sans text-sm leading-[normal] font-semibold hover:no-underline disabled:cursor-default disabled:opacity-50 ${
      ghost ? 'bg-rule-soft text-ink' : 'bg-accent text-white'
    } ${inline ? 'px-4 py-1.5' : 'w-full p-2'}`,
};
