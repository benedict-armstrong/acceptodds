/**
 * Two fields side by side, for the leaderboard's institution comparison
 * (`/leaderboard/compare`). Pure and client-safe. Display only: the curves
 * are floats for plotting, and the averages are rounded integers of figures
 * the board already shows; nothing here is money that moves.
 */
import { bandwidth } from './distribution';

/**
 * Each side's look, in order: the accent, then the blue tier. Here, not in
 * the chart's client module, so the page's caption and table can read it too:
 * a Server Component importing a value from a `'use client'` file gets a
 * client reference, not the value.
 */
export const SERIES = [
  { fill: 'fill-accent', stroke: 'stroke-accent', text: 'fill-accent', swatch: 'bg-accent' },
  { fill: 'fill-tier-4', stroke: 'stroke-tier-4', text: 'fill-tier-4', swatch: 'bg-tier-4' },
] as const;

/** Points each curve is sampled at, as `field-snapshot`'s. */
const POINTS = 120;

export interface FieldSummary {
  traders: number;
  /** Means and medians in micro-units, rounded toward zero; null for an empty field. */
  meanNetWorthMicro: bigint | null;
  medianNetWorthMicro: bigint | null;
  meanUnrealizedPnlMicro: bigint | null;
  meanSettledPnlMicro: bigint | null;
}

/** The arithmetic mean of `values`, rounded toward zero; null when empty. */
export function meanMicro(values: readonly bigint[]): bigint | null {
  if (values.length === 0) return null;
  return values.reduce((a, v) => a + v, 0n) / BigInt(values.length);
}

/** The median of `values` (the mean of the middle two for an even count); null when empty. */
export function medianMicro(values: readonly bigint[]): bigint | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2n;
}

export function summarize(
  rows: readonly { netWorthMicro: bigint; unrealizedPnlMicro: bigint; settledPnlMicro: bigint }[],
): FieldSummary {
  return {
    traders: rows.length,
    meanNetWorthMicro: meanMicro(rows.map((r) => r.netWorthMicro)),
    medianNetWorthMicro: medianMicro(rows.map((r) => r.netWorthMicro)),
    meanUnrealizedPnlMicro: meanMicro(rows.map((r) => r.unrealizedPnlMicro)),
    meanSettledPnlMicro: meanMicro(rows.map((r) => r.settledPnlMicro)),
  };
}

export interface SharedDensities {
  /** In units, common to every curve. */
  domain: [number, number];
  /**
   * Each field's kernel density at `POINTS` evenly spaced x's across `domain`,
   * all scaled by one factor so the highest peak is 1: each curve keeps its
   * own area, so a narrow field stands taller than a wide one, as it should.
   * Empty for an empty field.
   */
  curves: number[][];
}

/**
 * Kernel densities of several fields (sorted values in units) on one axis,
 * each with its own Silverman bandwidth, the domain running three of the
 * widest bandwidths past every field's extremes.
 */
export function sharedDensities(fields: readonly (readonly number[])[]): SharedDensities {
  const filled = fields.filter((f) => f.length > 0);
  if (filled.length === 0) return { domain: [0, 0], curves: fields.map(() => []) };
  const hs = fields.map((f) => (f.length > 0 ? bandwidth([...f]) : 0));
  const pad = 3 * Math.max(...hs);
  const lo = Math.min(...filled.map((f) => f[0])) - pad;
  const hi = Math.max(...filled.map((f) => f[f.length - 1])) + pad;
  const raw = fields.map((f, k) => {
    if (f.length === 0) return [];
    const h = hs[k];
    const norm = 1 / (f.length * h * Math.sqrt(2 * Math.PI));
    const ys: number[] = [];
    for (let i = 0; i < POINTS; i += 1) {
      const x = lo + ((hi - lo) * i) / (POINTS - 1);
      let sum = 0;
      for (const v of f) sum += Math.exp(-0.5 * ((x - v) / h) ** 2);
      ys.push(sum * norm);
    }
    return ys;
  });
  const peak = Math.max(...raw.flat());
  return { domain: [lo, hi], curves: raw.map((ys) => ys.map((y) => (peak > 0 ? y / peak : 0))) };
}
