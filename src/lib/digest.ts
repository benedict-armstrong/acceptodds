import { renderMail, type RenderedMail } from './mail-html';
import { headlineOf, headlinePrice, type HeadlineOf } from './headline';

/**
 * Pure helpers for followed papers' price moves and the daily digest mail.
 * No database, no I/O: `server/follows.ts` and `server/digest.ts` feed them.
 *
 * A "move" is about a **price** (a probability), never a value: nothing here
 * marks a position (§1.1).
 */

export interface Move extends HeadlineOf {
  /** The headline at the start of the window, replayed from the fills. */
  then: number;
  /** The headline now. */
  now: number;
}

/** The headline's move (`lib/headline.ts`): the first outcome of a binary market, else `1 − P(last)`. */
export function moveOf(pricesThen: readonly number[], pricesNow: readonly number[]): Move {
  return { ...headlineOf(pricesNow.length), then: headlinePrice(pricesThen), now: headlinePrice(pricesNow) };
}

/** The move in percentage points, signed. */
export function movePp(m: Pick<Move, 'then' | 'now'>): number {
  return (m.now - m.then) * 100;
}

/**
 * Whether a move reaches the threshold, in percentage points. Compared at a
 * hundredth of a point so float noise cannot decide a boundary case.
 */
export function movedEnough(m: Pick<Move, 'then' | 'now'>, minPp: number): boolean {
  return Math.round(Math.abs(movePp(m)) * 100) >= Math.round(minPp * 100);
}

/** `DIGEST_MIN_MOVE_PP`, default 5; a bad value falls back to the default. */
export function minMovePp(env: string | undefined = process.env.DIGEST_MIN_MOVE_PP): number {
  const v = env === undefined || env.trim() === '' ? NaN : Number(env);
  return Number.isFinite(v) && v > 0 && v <= 100 ? v : 5;
}

export const DEFAULT_DIGEST_TIMEZONE = 'Europe/Zurich';

/** The calendar day of `at` in `timeZone`, as `YYYY-MM-DD`: the digest's idempotency key. */
export function digestDay(at: Date, timeZone: string = DEFAULT_DIGEST_TIMEZONE): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(at)
    .reduce<Record<string, string>>((acc, p) => ({ ...acc, [p.type]: p.value }), {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** A whole-percent price for mail, like the UI's `pct`. */
function pct(p: number): string {
  const v = Math.round(p * 100);
  if (v === 0 && p > 0) return '<1%';
  if (v === 100 && p < 1) return '>99%';
  return `${v}%`;
}

function pp(m: Pick<Move, 'then' | 'now'>): string {
  const v = Math.round(movePp(m));
  return `${v > 0 ? '+' : v < 0 ? '−' : '±'}${Math.abs(v)} pp`;
}

export interface DigestItem extends Move {
  title: string;
  slug: string;
  question: string;
  /** The headline outcome's label: for a multi-outcome market the one it is the complement of. */
  outcomeLabel: string;
  binary: boolean;
}

/** The digest mail. Biggest moves first. */
export function renderDigest(items: readonly DigestItem[], baseUrl: string): RenderedMail {
  const base = baseUrl.replace(/\/+$/, '');
  const sorted = [...items].sort((a, b) => Math.abs(movePp(b)) - Math.abs(movePp(a)));
  const n = sorted.length;
  const what = (i: DigestItem) => (i.binary ? '' : i.negated ? ` (not ${i.outcomeLabel})` : ` (${i.outcomeLabel})`);
  const href = (i: DigestItem) => `${base}/papers/${encodeURIComponent(i.slug)}`;
  const plain = sorted
    .map((i) =>
      [`${i.title}`, `  ${i.question}${what(i)}: ${pct(i.then)} → ${pct(i.now)} (${pp(i)})`, `  ${href(i)}`].join('\n'),
    )
    .join('\n\n');
  return renderMail({
    siteUrl: base,
    subject: `acceptodds: ${n} followed paper${n === 1 ? '' : 's'} moved in the last 24 hours`,
    title: 'Morning digest',
    byline: `${n} followed paper${n === 1 ? '' : 's'} moved in the last 24 hours`,
    blocks: [
      { kind: 'p', text: `Prices on papers you follow moved over the last 24 hours:` },
      {
        kind: 'table',
        caption: 'Headline price a day ago and now, biggest move first.',
        columns: [
          { label: 'Paper' },
          { label: 'Then', numeric: true },
          { label: 'Now', numeric: true },
          { label: 'Move', numeric: true },
        ],
        rows: sorted.map((i) => [
          { text: i.title, href: href(i), sub: `${i.question}${what(i)}` },
          { text: pct(i.then) },
          { text: pct(i.now) },
          { text: pp(i), tone: i.now > i.then ? 'up' : i.now < i.then ? 'down' : undefined },
        ]),
        plain,
      },
    ],
    notes: [
      `Prices are the market's implied probabilities, not a forecast of ours.`,
      `You get this because you follow these papers. To stop these emails, or unfollow, go to ${base}/profile#email`,
    ],
  });
}
