/**
 * Display formatting for the UI. Client-safe: no server imports.
 *
 * Amounts arrive from the API as micro-unit decimal strings (§1.6). They are
 * formatted from `bigint`, never parsed into a float, so the number a person
 * sees is the number the ledger holds.
 */

const MICRO = 1_000_000n;

/** The unit reputation is shown in, after the amount: "1,000.00 $rep". */
export const REP = '$rep';

function group(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** "1184200000" -> "1,184.20". Rounds toward zero at the last shown place. */
export function rep(micro: string | bigint, decimals = 2): string {
  const v = typeof micro === 'bigint' ? micro : BigInt(micro);
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const whole = group((abs / MICRO).toString());
  const frac = (abs % MICRO).toString().padStart(6, '0').slice(0, decimals);
  return `${neg ? '−' : ''}${whole}${decimals > 0 ? '.' + frac : ''}`;
}

/** A P&L: "+12.30", "−3.00", "0.00". */
export function signedRep(micro: string | bigint, decimals = 2): string {
  const v = typeof micro === 'bigint' ? micro : BigInt(micro);
  return `${v > 0n ? '+' : ''}${rep(v, decimals)}`;
}

/**
 * Share counts: "40000000" -> "40", "12500000" -> "12.5". With `maxDecimals`,
 * truncated, never rounded up: a holding is never shown as more than it is.
 */
export function shares(micro: string | bigint, maxDecimals = 6): string {
  const v = typeof micro === 'bigint' ? micro : BigInt(micro);
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const frac = (abs % MICRO).toString().padStart(6, '0').slice(0, maxDecimals).replace(/0+$/, '');
  return `${neg ? '−' : ''}${group((abs / MICRO).toString())}${frac ? '.' + frac : ''}`;
}

/**
 * A change as a share of its base: "+5.0%", "−5.0%", "+0.0%". A float, for
 * display only; "—" when the base is zero or less, as nothing is at stake.
 */
export function signedPctOf(changeMicro: bigint, baseMicro: bigint): string {
  if (baseMicro <= 0n) return '—';
  const size = changeMicro < 0n ? -changeMicro : changeMicro;
  return `${changeMicro < 0n ? '−' : '+'}${((Number(size) / Number(baseMicro)) * 100).toFixed(1)}%`;
}

/** 0.6213 -> "62%"; `precise` -> "62.1%". */
export function pct(p: number, precise = false): string {
  if (precise) return `${(p * 100).toFixed(1)}%`;
  const v = Math.round(p * 100);
  if (v === 0 && p > 0) return '<1%';
  if (v === 100 && p < 1) return '>99%';
  return `${v}%`;
}

/**
 * What a payout returns on its cost, for display: a multiple ("×3.20") when
 * it at least doubles the money, else the gain as a percentage ("+35%",
 * "−2%"). A float, for display only; `null` for a zero cost.
 */
export function payoutReturn(payoutMicro: bigint, costMicro: bigint): string | null {
  if (costMicro <= 0n) return null;
  const ratio = Number(payoutMicro) / Number(costMicro);
  if (ratio >= 2) return `×${ratio.toFixed(2)}`;
  const gain = Math.round((ratio - 1) * 100);
  return `${gain < 0 ? '−' : '+'}${Math.abs(gain)}%`;
}

// Dates are spelled out by hand, in UTC, never through `toLocaleString`: the
// server's ICU and the browser's disagree ("13 Sept" vs "13 Sep" in en-GB),
// and a client component rendered on both then fails to hydrate.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "13 Sep", UTC. */
export function dayMonth(at: string | Date | number): string {
  const d = new Date(at);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** "09:05", UTC, 24-hour. */
export function clock(at: string | Date | number): string {
  const d = new Date(at);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

/** "13 Sep 2026", UTC. */
export function day(iso: string | Date): string {
  return `${dayMonth(iso)} ${new Date(iso).getUTCFullYear()}`;
}

export function ago(iso: string | Date, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/**
 * `text` cut to at most `max` characters, at a word break when one is near,
 * with an ellipsis; unchanged when it fits. Counts code points, so a cut
 * never splits a surrogate pair.
 */
export function clip(text: string, max: number): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  const head = chars.slice(0, max - 1).join('');
  const space = head.lastIndexOf(' ');
  const cut = space >= head.length * 0.6 ? head.slice(0, space) : head;
  return `${cut.trimEnd()}…`;
}
