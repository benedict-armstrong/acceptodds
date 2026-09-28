/**
 * Display formatting for the UI. Client-safe: no server imports.
 *
 * Amounts arrive from the API as micro-unit decimal strings (§1.6). They are
 * formatted from `bigint`, never parsed into a float, so the number a person
 * sees is the number the ledger holds.
 */

const MICRO = 1_000_000n;

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

/** Share counts: "40000000" -> "40", "12500000" -> "12.5". */
export function shares(micro: string | bigint): string {
  const v = typeof micro === 'bigint' ? micro : BigInt(micro);
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const frac = (abs % MICRO).toString().padStart(6, '0').replace(/0+$/, '');
  return `${neg ? '−' : ''}${group((abs / MICRO).toString())}${frac ? '.' + frac : ''}`;
}

/** 0.6213 -> "62%"; `precise` -> "62.1%". */
export function pct(p: number, precise = false): string {
  if (precise) return `${(p * 100).toFixed(1)}%`;
  const v = Math.round(p * 100);
  if (v === 0 && p > 0) return '<1%';
  if (v === 100 && p < 1) return '>99%';
  return `${v}%`;
}

export function day(iso: string | Date): string {
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

export function ago(iso: string | Date, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}
