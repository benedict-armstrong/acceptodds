/**
 * The shape of a field of numbers, for the portfolio's "where you stand"
 * chart. Pure and client-safe. Display only: the inputs are already-rounded
 * figures converted for plotting, and nothing here is ever money that moves.
 */

/**
 * The narrowest a kernel may be, as a share of the field's range. Most
 * traders sit near the starting balance, so the IQR (and with it Silverman's
 * bandwidth) is tiny, and the curve was one spike with flat tails. Drawn at
 * this width, the crowd is a bump and the rest of the field reads beside it.
 */
const MIN_BANDWIDTH_OF_RANGE = 1 / 20;

/**
 * Silverman's rule-of-thumb bandwidth, `0.9 · min(σ, IQR/1.34) · n^(−1/5)`,
 * floored at `MIN_BANDWIDTH_OF_RANGE` of the range, and so that a field of
 * identical values (σ = 0) still draws a bump rather than dividing by zero.
 * `values` sorted ascending.
 */
export function bandwidth(values: number[]): number {
  const n = values.length;
  if (n === 0) return 1;
  const mean = values.reduce((a, v) => a + v, 0) / n;
  const sd = Math.sqrt(values.reduce((a, v) => a + (v - mean) ** 2, 0) / Math.max(1, n - 1));
  const iqr = quantile(values, 0.75) - quantile(values, 0.25);
  const spread = iqr > 0 ? Math.min(sd, iqr / 1.34) : sd;
  const h = 0.9 * spread * n ** -0.2;
  const range = values[n - 1] - values[0];
  // A floor relative to the values' size, so a flat field is a visible bump.
  return Math.max(h, range * MIN_BANDWIDTH_OF_RANGE, Math.abs(mean) * 0.01, 1e-6);
}

/** The `p` quantile of sorted `values`, linearly interpolated. */
export function quantile(values: number[], p: number): number {
  if (values.length === 0) return NaN;
  const i = (values.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return values[lo] + (values[hi] - values[lo]) * (i - lo);
}

export interface Density {
  /** Evenly spaced from `domain[0]` to `domain[1]`. */
  xs: number[];
  /** The Gaussian kernel density at each x; integrates to ~1 over the domain. */
  ys: number[];
  domain: [number, number];
  bandwidth: number;
}

/**
 * A Gaussian kernel density estimate of sorted `values` at `points` evenly
 * spaced x's. The domain runs three bandwidths past the extremes (and past
 * `include`, so a marker is always on the chart), where the curve has all but
 * reached zero.
 */
export function density(values: number[], points = 120, include?: number): Density {
  const h = bandwidth(values);
  const lo = Math.min(values[0], include ?? values[0]) - 3 * h;
  const hi = Math.max(values[values.length - 1], include ?? values[values.length - 1]) + 3 * h;
  const xs: number[] = [];
  const ys: number[] = [];
  const norm = 1 / (values.length * h * Math.sqrt(2 * Math.PI));
  for (let i = 0; i < points; i += 1) {
    const x = lo + ((hi - lo) * i) / (points - 1);
    let sum = 0;
    for (const v of values) sum += Math.exp(-0.5 * ((x - v) / h) ** 2);
    xs.push(x);
    ys.push(sum * norm);
  }
  return { xs, ys, domain: [lo, hi], bandwidth: h };
}

/**
 * Densities for drawing: scaled so the highest of `ys` is 1, then square-
 * rooted (a rootogram's scale). On a linear scale the crowd near the
 * starting balance stood a hundred times taller than a lone trader further
 * out, who was then a flat line; rooted, they are a tenth of it. Still
 * monotonic, so a taller curve is still more traders.
 */
export function rootScaled(ys: readonly number[], peak = Math.max(...ys)): number[] {
  return ys.map((y) => (peak > 0 ? Math.sqrt(y / peak) : 0));
}

/** How many of sorted `values` are strictly below `x`, by binary search. */
export function countBelow(values: number[], x: number): number {
  let lo = 0;
  let hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (values[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * About `count` round tick values inside `[lo, hi]`: steps of 1, 2 or 5
 * times a power of ten.
 */
export function niceTicks(lo: number, hi: number, count = 4): number[] {
  if (!(hi > lo)) return [lo];
  const raw = (hi - lo) / count;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? 10 * pow;
  const out: number[] = [];
  for (let t = Math.ceil(lo / step) * step; t <= hi + step * 1e-9; t += step) out.push(Number(t.toPrecision(12)));
  return out;
}
