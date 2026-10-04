import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type SimulationNodeDatum,
} from 'd3-force';
import { MAP_SIZE, normalise } from './map';

/**
 * Re-lays out a subset of the paper map in the browser, for `/map`'s
 * "redraw": the matches of a search, spread over the screen and grouped
 * among themselves. Display only — never stored or sent anywhere; the map
 * itself stays the supplier's (`PUT /map`).
 *
 * A force layout over two kinds of edge: the similarity service's related
 * lists between matches (`GET /map/related`), and each match's nearest
 * matches on the supplied map, so a paper with no related list stays near
 * what it was near, and the overall shape stays recognisable. It starts
 * from the supplied positions, rescaled to fill the map.
 */

/** How hard a paper is pulled to its cluster's centre, and to the map's. */
const CLUSTER_PULL = 0.15;
const CENTRE_PULL = 0.03;
/** A link's rest length at the typical neighbour distance, in multiples of the even spacing. */
const LINK_LENGTH = 0.3;
/** Nearest matches on the supplied map each match is tied to. */
const NEAREST = 6;
/**
 * It starts from the supplied layout, which is already close, so few ticks
 * settle it. The many-body repulsion is the whole cost (d3's Barnes–Hut,
 * ~0.8 s for 4k nodes); the links are cheap.
 */
const TICKS = 120;
/** Ticks between frames yielded by `settle`. */
const TICKS_PER_SLICE = 4;

/**
 * More than this and the layout takes several seconds even off the main
 * thread (`map-layout.worker.ts`); the matches are shown in place instead.
 */
export const MAX_RELAYOUT = 10_000;

interface Node extends SimulationNodeDatum {
  x: number;
  y: number;
}

/**
 * Lay out a subset from `start`, its interleaved positions on the supplied
 * map, tied by `related` (directed pairs of indexes into the subset) and
 * drawn together by `groups` (the supplier's cluster per point, or -1).
 * Yields interleaved positions scaled to `[0, MAP_SIZE]` every few ticks, so
 * the layout can be drawn as it settles; the last is the settled layout.
 * Synchronous between yields: run it in a worker.
 */
export function* settle(
  start: Float32Array,
  related: readonly [number, number][],
  groups: Int32Array,
): Generator<Float32Array> {
  const n = start.length / 2;
  const from = normalise(Array.from({ length: n }, (_, k) => ({ x: start[2 * k], y: start[2 * k + 1] })));
  if (n < 3) {
    yield from;
    return;
  }
  const nodes: Node[] = Array.from({ length: n }, (_, k) => ({ x: from[2 * k], y: from[2 * k + 1] }));

  // Spacing that suits the number of nodes: about the gap they would have spread evenly over the map.
  const gap = MAP_SIZE / Math.sqrt(n);

  const seen = new Set<number>();
  const links: { source: number; target: number; strength: number; distance: number }[] = [];
  const link = (a: number, b: number, strength: number, distance: number) => {
    if (a === b) return;
    const key = Math.min(a, b) * n + Math.max(a, b);
    if (seen.has(key)) return;
    seen.add(key);
    links.push({ source: a, target: b, strength, distance });
  };
  for (const [a, b] of related) link(a, b, 0.6, gap * LINK_LENGTH);
  // Near neighbours keep their distances from the supplied map, relative to
  // the typical one and compressed (square root), so close stays closer
  // without a sparse subset keeping its gaps. Not their positions: the
  // subset is free to close up.
  const near = nearestNeighbours(start, NEAREST);
  const apart = (a: number, b: number) => Math.hypot(start[2 * a] - start[2 * b], start[2 * a + 1] - start[2 * b + 1]);
  const typical = median(near.flatMap((ns, a) => ns.map((b) => apart(a, b)))) || 1;
  near.forEach((ns, a) =>
    ns.forEach((b) => link(a, b, 0.3, gap * LINK_LENGTH * Math.min(Math.sqrt(apart(a, b) / typical), 3))),
  );
  const simulation = forceSimulation(nodes)
    .force(
      'link',
      forceLink<Node, (typeof links)[number]>(links)
        .distance((l) => l.distance)
        .strength((l) => l.strength),
    )
    // Gathers each cluster: what makes the subset read as groups rather than an even spread.
    .force('cluster', forceCluster(groups, CLUSTER_PULL))
    // No distanceMax: a hard cut-off leaves papers piled on circles of that radius around every dense spot.
    // A coarse Barnes–Hut (theta 1.5) is fine without one, and half the cost of the default.
    .force(
      'charge',
      forceManyBody<Node>()
        .strength(-gap * 0.12)
        .theta(1.5),
    )
    // A gentle pull to the centre, so groups with no tie between them still close up.
    .force('x', forceX<Node>(MAP_SIZE / 2).strength(CENTRE_PULL))
    .force('y', forceY<Node>(MAP_SIZE / 2).strength(CENTRE_PULL))
    .alphaDecay(1 - Math.pow(0.001, 1 / TICKS))
    .stop();

  for (let t = 0; t < TICKS; t += TICKS_PER_SLICE) {
    simulation.tick(TICKS_PER_SLICE);
    yield normalise(nodes);
  }
}

/** `settleAround` works in multiples of a dot's room, `ROOM`: the caller rescales (`lib/map.ts` `frameAround`). */
const ROOM = 10;
/** Two related papers in a group aim for this far apart, in `ROOM`s. */
const PAIR_LENGTH = 2.6;
/** The clear space round the paper at the centre, and between groups, in `ROOM`s. */
const CENTRE_GAP = 3;
const GROUP_GAP = 2;
/** Papers this many pair lengths apart on the map or nearer keep their distance inside a group. */
const NEAR_ON_MAP = 2.5;
/** Frames the redraw is animated over, from the map to the layout. */
const AROUND_FRAMES = 36;

/** The smallest group `relatedGroups` keeps; smaller ones join a bigger one. */
const MIN_GROUP = 3;

/**
 * Groups among a piece's papers (interleaved `positions`), by label
 * propagation over the related pairs: each paper takes the label most of
 * its ties have, in a fixed order, ties to the lowest, until nothing
 * changes. Deterministic. A group smaller than `MIN_GROUP` (a paper with no
 * tie is one) joins the big group it has most ties to, else the big group
 * of its nearest paper on the map: strays would otherwise be groups of their
 * own, out on the edge. `skip` (the paper at the centre) is in no group
 * (-1). Groups are numbered 0, 1, … in order of first appearance.
 */
export function relatedGroups(positions: Float32Array, related: readonly [number, number][], skip: number): Int32Array {
  const n = positions.length / 2;
  const ties: number[][] = Array.from({ length: n }, () => []);
  for (const [a, b] of related) {
    if (a === skip || b === skip || a === b) continue;
    ties[a].push(b);
    ties[b].push(a);
  }
  const label = Int32Array.from({ length: n }, (_, i) => i);
  for (let round = 0; round < 30; round++) {
    let changed = false;
    for (let i = 0; i < n; i++) {
      if (ties[i].length === 0) continue;
      const count = new Map<number, number>();
      for (const j of ties[i]) count.set(label[j], (count.get(label[j]) ?? 0) + 1);
      let best = label[i];
      let most = count.get(best) ?? 0;
      for (const [l, c] of count) if (c > most || (c === most && l < best)) [best, most] = [l, c];
      if (best !== label[i]) {
        label[i] = best;
        changed = true;
      }
    }
    if (!changed) break;
  }
  const size = new Map<number, number>();
  label.forEach((l, i) => i !== skip && size.set(l, (size.get(l) ?? 0) + 1));
  const big = (l: number) => (size.get(l) ?? 0) >= MIN_GROUP;
  const out = Int32Array.from(label);
  if ([...size.keys()].some(big)) {
    for (let i = 0; i < n; i++) {
      if (i === skip || big(label[i])) continue;
      const count = new Map<number, number>();
      for (const j of ties[i]) if (big(label[j])) count.set(label[j], (count.get(label[j]) ?? 0) + 1);
      let best = -1;
      let most = 0;
      for (const [l, c] of count) if (c > most || (c === most && l < best)) [best, most] = [l, c];
      if (best < 0) {
        let nearest = Infinity;
        for (let j = 0; j < n; j++) {
          const d = Math.hypot(positions[2 * i] - positions[2 * j], positions[2 * i + 1] - positions[2 * j + 1]);
          if (j !== skip && big(label[j]) && d < nearest) [nearest, best] = [d, label[j]];
        }
      }
      out[i] = best;
    }
  } else {
    // No group is big enough: one group of everything.
    out.fill(0);
  }
  out[skip] = -1;
  const renumber = new Map<number, number>();
  return out.map((l) => (l < 0 ? -1 : (renumber.get(l) ?? renumber.set(l, renumber.size).get(l)!)));
}

/**
 * Lay out a paper's piece of the map round it, for the paper page's
 * minimap: its papers in groups, each group compact, the groups round the
 * paper. Locally the supplied map is an even spread (a paper's nearest
 * papers fill a disc), so the groups come from relatedness
 * (`relatedGroups` over `related`). In two stages:
 *
 * 1. each group on its own: its related pairs tied short, its map
 *    distances a weak base, collision only — no repulsion, which evens a
 *    group into a lattice;
 * 2. the groups as discs round point `self` at the centre: each pulled in
 *    the direction it lies from the paper on the map, as close as it fits,
 *    kept apart by collision. A group holding more of the paper's related
 *    papers (`ranked`) sits nearer.
 *
 * Yields frames easing from the map (compressed round the paper) to the
 * layout, so the redraw is animated; the last is the layout. Display only,
 * like `settle`. Not normalised: the paper stays at the centre and the
 * caller frames round it (`lib/map.ts` `frameAround`).
 */
export function* settleAround(
  start: Float32Array,
  self: number,
  ranked: readonly number[],
  related: readonly [number, number][],
): Generator<Float32Array> {
  const n = start.length / 2;
  const cx = MAP_SIZE / 2;
  if (n < 3) {
    yield normalise(Array.from({ length: n }, (_, k) => ({ x: start[2 * k], y: start[2 * k + 1] })));
    return;
  }
  const near = nearestNeighbours(start, 1);
  const typical = median(near.flatMap((ns, a) => ns.map((b) => apartIn(start, a, b)))) || 1;
  // Map units to rooms: neighbours on the map start about a pair's length apart.
  const unit = (PAIR_LENGTH * ROOM) / typical;
  const group = relatedGroups(start, related, self);
  const members = new Map<number, number[]>();
  group.forEach((g, i) => g >= 0 && (members.get(g) ?? members.set(g, []).get(g)!).push(i));

  // 1. Each group, round its own centre.
  const local = new Float32Array(2 * n);
  const discs: { g: number; radius: number; angle: number; related: number }[] = [];
  const rankedSet = new Set(ranked);
  const tiedIn = (i: number) => related.filter(([a, b]) => a === i || b === i);
  for (const [g, idx] of members) {
    const at = new Map(idx.map((i, k) => [i, k]));
    const mx = idx.reduce((a, i) => a + start[2 * i], 0) / idx.length;
    const my = idx.reduce((a, i) => a + start[2 * i + 1], 0) / idx.length;
    // Starting from the map, but no farther out than a group this size spans: a member far away on the map
    // (a related paper, often) would otherwise hold the whole group open.
    const span = Math.sqrt(idx.length) * PAIR_LENGTH * ROOM;
    const nodes: Node[] = idx.map((i) => {
      const x = (start[2 * i] - mx) * unit;
      const y = (start[2 * i + 1] - my) * unit;
      const f = Math.min(1, span / (Math.hypot(x, y) || 1));
      return { x: x * f, y: y * f };
    });
    const links: { source: number; target: number; distance: number; strength: number }[] = [];
    // The map's shape, only among papers near each other on it.
    for (let a = 0; a < idx.length; a++) {
      for (let b = a + 1; b < idx.length; b++) {
        const d = apartIn(start, idx[a], idx[b]) * unit;
        if (d < NEAR_ON_MAP * PAIR_LENGTH * ROOM) links.push({ source: a, target: b, distance: d, strength: 0.15 });
      }
    }
    for (const i of idx) {
      for (const [a, b] of tiedIn(i)) {
        const j = a === i ? b : a;
        if (i < j && at.has(j))
          links.push({ source: at.get(i)!, target: at.get(j)!, distance: PAIR_LENGTH * ROOM, strength: 0.4 });
      }
    }
    const simulation = forceSimulation(nodes)
      .force(
        'link',
        forceLink<Node, (typeof links)[number]>(links)
          .distance((l) => l.distance)
          .strength((l) => l.strength),
      )
      .force('collide', forceCollide<Node>(ROOM).strength(0.9))
      .force('x', forceX<Node>(0).strength(0.08))
      .force('y', forceY<Node>(0).strength(0.08))
      .stop();
    simulation.tick(200);
    let radius = ROOM;
    nodes.forEach((d, k) => {
      local[2 * idx[k]] = d.x;
      local[2 * idx[k] + 1] = d.y;
      radius = Math.max(radius, Math.hypot(d.x, d.y) + ROOM);
    });
    discs.push({
      g,
      radius,
      angle: Math.atan2(my - start[2 * self + 1], mx - start[2 * self]),
      related: idx.filter((i) => rankedSet.has(i)).length,
    });
  }

  // 2. The groups round the paper: biggest share of its related papers first, so they get the nearest places.
  discs.sort((a, b) => b.related - a.related || b.radius - a.radius);
  const centre: Node = { x: 0, y: 0, fx: 0, fy: 0 };
  const placed: (Node & { r: number })[] = discs.map((d) => {
    const reach = CENTRE_GAP * ROOM + d.radius;
    return { x: reach * Math.cos(d.angle), y: reach * Math.sin(d.angle), r: d.radius };
  });
  const all = [{ ...centre, r: CENTRE_GAP * ROOM }, ...placed];
  const toward = (k: number, axis: 'x' | 'y') => {
    const d = discs[k];
    const reach = CENTRE_GAP * ROOM + d.radius * (d.related > 0 ? 0.6 : 1);
    return reach * (axis === 'x' ? Math.cos(d.angle) : Math.sin(d.angle));
  };
  forceSimulation(all)
    .force('x', forceX<Node & { r: number }>((_, k) => (k === 0 ? 0 : toward(k - 1, 'x'))).strength(0.1))
    .force('y', forceY<Node & { r: number }>((_, k) => (k === 0 ? 0 : toward(k - 1, 'y'))).strength(0.1))
    .force(
      'collide',
      forceCollide<Node & { r: number }>((d) => d.r + GROUP_GAP * ROOM)
        .strength(1)
        .iterations(3),
    )
    .stop()
    .tick(300);

  const end = new Float32Array(2 * n);
  end[2 * self] = cx;
  end[2 * self + 1] = cx;
  discs.forEach((d, k) => {
    for (const i of members.get(d.g)!) {
      end[2 * i] = cx + all[k + 1].x + local[2 * i];
      end[2 * i + 1] = cx + all[k + 1].y + local[2 * i + 1];
    }
  });

  // From the map, compressed round the paper to about the layout's size, eased to the layout.
  const reach = Math.max(...Array.from({ length: n }, (_, i) => Math.hypot(end[2 * i] - cx, end[2 * i + 1] - cx)), 1);
  const far = Math.max(...Array.from({ length: n }, (_, i) => apartIn(start, i, self)), 1e-9);
  const begin = new Float32Array(2 * n);
  for (let i = 0; i < n; i++) {
    const d = apartIn(start, i, self);
    const f = d === 0 ? 0 : (reach * Math.sqrt(d / far)) / d;
    begin[2 * i] = cx + (start[2 * i] - start[2 * self]) * f;
    begin[2 * i + 1] = cx + (start[2 * i + 1] - start[2 * self + 1]) * f;
  }
  for (let f = 1; f <= AROUND_FRAMES; f++) {
    const t = f / AROUND_FRAMES;
    const e = t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2;
    yield begin.map((b, j) => b + (end[j] - b) * e);
  }
}

function apartIn(p: Float32Array, a: number, b: number): number {
  return Math.hypot(p[2 * a] - p[2 * b], p[2 * a + 1] - p[2 * b + 1]);
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[sorted.length >> 1];
}

/**
 * Pulls each node toward the centre of its group (-1: none), recomputed
 * every tick. d3 has no such force; this is the usual one, linear in the
 * nodes.
 */
function forceCluster(groups: Int32Array, strength: number) {
  let nodes: Node[] = [];
  const force = (alpha: number) => {
    const sum = new Map<number, { x: number; y: number; n: number }>();
    nodes.forEach((d, k) => {
      const g = groups[k];
      if (g < 0) return;
      const c = sum.get(g) ?? sum.set(g, { x: 0, y: 0, n: 0 }).get(g)!;
      c.x += d.x;
      c.y += d.y;
      c.n++;
    });
    nodes.forEach((d, k) => {
      const c = groups[k] < 0 ? undefined : sum.get(groups[k]);
      if (!c || c.n < 2) return;
      d.vx! += (c.x / c.n - d.x) * strength * alpha;
      d.vy! += (c.y / c.n - d.y) * strength * alpha;
    });
  };
  force.initialize = (n: Node[]) => {
    nodes = n;
  };
  return force;
}

/**
 * Each point's `k` nearest others (interleaved positions), by a uniform grid
 * sized so a cell holds about `k` points, searched ring by ring outward.
 */
export function nearestNeighbours(positions: Float32Array, k: number): number[][] {
  const n = positions.length / 2;
  if (n <= 1) return Array.from({ length: n }, () => []);
  const xs = positions.filter((_, j) => j % 2 === 0);
  const ys = positions.filter((_, j) => j % 2 === 1);
  const [minX, maxX] = [xs.reduce((a, v) => Math.min(a, v)), xs.reduce((a, v) => Math.max(a, v))];
  const [minY, maxY] = [ys.reduce((a, v) => Math.min(a, v)), ys.reduce((a, v) => Math.max(a, v))];
  const cell = Math.max(Math.sqrt(((maxX - minX || 1) * (maxY - minY || 1) * k) / n), 1e-9);
  const cols = Math.floor((maxX - minX) / cell) + 1;
  const rows = Math.floor((maxY - minY) / cell) + 1;
  const grid = new Map<number, number[]>();
  const cx = (i: number) => Math.floor((positions[2 * i] - minX) / cell);
  const cy = (i: number) => Math.floor((positions[2 * i + 1] - minY) / cell);
  for (let i = 0; i < n; i++) {
    const key = cy(i) * cols + cx(i);
    (grid.get(key) ?? grid.set(key, []).get(key)!).push(i);
  }
  const want = Math.min(k, n - 1);
  return Array.from({ length: n }, (_, i) => {
    const x = positions[2 * i];
    const y = positions[2 * i + 1];
    const found: [number, number][] = [];
    // Grow the ring until it holds enough points and one more ring could hold none nearer.
    for (let r = 0; r <= Math.max(cols, rows); r++) {
      for (let gy = cy(i) - r; gy <= cy(i) + r; gy++) {
        for (let gx = cx(i) - r; gx <= cx(i) + r; gx++) {
          if (Math.max(Math.abs(gx - cx(i)), Math.abs(gy - cy(i))) !== r) continue;
          if (gx < 0 || gy < 0 || gx >= cols || gy >= rows) continue;
          for (const j of grid.get(gy * cols + gx) ?? []) {
            if (j !== i) found.push([(positions[2 * j] - x) ** 2 + (positions[2 * j + 1] - y) ** 2, j]);
          }
        }
      }
      if (found.length >= want) {
        found.sort((a, b) => a[0] - b[0]);
        if (found[want - 1][0] <= (r * cell) ** 2) break;
      }
    }
    found.sort((a, b) => a[0] - b[0]);
    return found.slice(0, want).map(([, j]) => j);
  });
}
