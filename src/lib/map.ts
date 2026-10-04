import { likelihood, type Likelihood } from './likelihood';

/**
 * The paper map's display maths (`/map`). Client-safe and pure. The layout
 * itself is supplied (`PUT /map`); this only scales it to the screen, places
 * the grouping names and picks colours.
 */

/** Map units across the longer side, whatever the supplier's units were. */
export const MAP_SIZE = 1000;

/**
 * Scale points into `[0, MAP_SIZE]` on the longer axis, keeping the aspect,
 * centred on the shorter, y pointing up. Interleaved `[x0, y0, x1, y1, …]`.
 */
export function normalise(points: readonly { x: number; y: number }[]): Float32Array {
  const out = new Float32Array(points.length * 2);
  if (points.length === 0) return out;
  // A loop, not Math.min(...xs): spreading a whole map overflows the call stack.
  const span = (v: (p: { x: number; y: number }) => number) =>
    points.reduce(([lo, hi], p) => [Math.min(lo, v(p)), Math.max(hi, v(p))], [Infinity, -Infinity]);
  const [minX, maxX] = span((p) => p.x);
  const [minY, maxY] = span((p) => p.y);
  const w = maxX - minX;
  const h = maxY - minY;
  const scale = MAP_SIZE / (Math.max(w, h) || 1);
  const offX = (MAP_SIZE - w * scale) / 2;
  const offY = (MAP_SIZE - h * scale) / 2;
  points.forEach((p, i) => {
    out[2 * i] = offX + (p.x - minX) * scale;
    out[2 * i + 1] = offY + (p.y - minY) * scale;
  });
  return out;
}

export interface TopicLabel {
  number: number;
  text: string;
  x: number;
  y: number;
  /** Points in the grouping: the bigger wins a label collision. */
  size: number;
}

/**
 * Where each grouping's name goes: the median of its points on each axis
 * (robust to a few strays far from the rest). Groupings with fewer than
 * `minSize` points, or no name, get no label.
 */
export function topicLabels(
  positions: Float32Array,
  groups: readonly (number | null)[],
  names: ReadonlyMap<number, string>,
  minSize: number,
): TopicLabel[] {
  const xs = new Map<number, number[]>();
  const ys = new Map<number, number[]>();
  groups.forEach((g, i) => {
    if (g === null || !names.has(g)) return;
    if (!xs.has(g)) {
      xs.set(g, []);
      ys.set(g, []);
    }
    xs.get(g)!.push(positions[2 * i]);
    ys.get(g)!.push(positions[2 * i + 1]);
  });
  const median = (a: number[]) => a.sort((u, v) => u - v)[a.length >> 1];
  const out: TopicLabel[] = [];
  for (const [g, x] of xs) {
    if (x.length < minSize) continue;
    out.push({ number: g, text: names.get(g)!, x: median(x), y: median(ys.get(g)!), size: x.length });
  }
  return out;
}

export type Rgb = [number, number, number];

export function hexRgb(hex: string): Rgb {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}

/**
 * Categorical colours for groupings and areas, cycled. Muted, so the
 * maroon accent (a selection) stays the loud colour.
 */
export const MAP_PALETTE: readonly Rgb[] = [
  '#4e79a7',
  '#e08b3a',
  '#59a14f',
  '#c75a5d',
  '#76b7b2',
  '#b6992d',
  '#9c6fa0',
  '#d4848f',
  '#8a6e58',
  '#5f8fc4',
  '#86bc6c',
  '#a1a1a1',
  '#3f8f86',
  '#c9a46a',
  '#7b6fb0',
  '#9b9a4a',
].map(hexRgb);

export const MAP_NONE: Rgb = hexRgb('#c8c4ba');

export function categoryRgb(n: number | null): Rgb {
  return n === null || n < 0 ? MAP_NONE : MAP_PALETTE[n % MAP_PALETTE.length];
}

/** Mirrors the `accept` / `toss-up` / `reject` tokens in `app/globals.css`, for WebGL. Keep in step. */
export const LIKELIHOOD_RGB: Record<Likelihood, Rgb> = {
  accept: hexRgb('#3d7a4f'),
  'toss-up': hexRgb('#b8ab8c'),
  reject: hexRgb('#a24a3f'),
};

/** A paper coloured by its headline price, in the site's likelihood colours; uncoloured when void or unpriced. */
export function headlineRgb(h: number | null): Rgb {
  return h === null ? MAP_NONE : LIKELIHOOD_RGB[likelihood(h)];
}

/**
 * Dot radius multiplier at a zoom level: about 1.5x per level past the
 * opening view, never smaller than at it, capped so dense regions stay
 * legible.
 */
export function dotScale(zoom: number, openingZoom: number): number {
  return Math.min(6, Math.max(1, 1.5 ** (zoom - openingZoom)));
}

/**
 * Dot radius multiplier for showing `shown` of `total` papers: fewer dots,
 * bigger, so a sparse search does not leave the screen empty. The fourth
 * root keeps it gentle (179 of 30k: about 3.6x; 4k of 30k: about 1.7x),
 * capped at 4x.
 */
export function sparseScale(shown: number, total: number): number {
  if (shown <= 0 || shown >= total) return 1;
  return Math.min(4, (total / shown) ** 0.25);
}
