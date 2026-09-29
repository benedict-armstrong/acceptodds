/**
 * Leaderboard arithmetic the page needs and the API does not. Pure.
 */

/**
 * Which rows of a ranked list of `total` the compact view shows, as
 * half-open `[start, end)` index ranges in order: the top `top`, and `radius`
 * either side of `focus` (the viewer, or whoever was asked for). Ranges that
 * touch or overlap are merged, and so are ranges one row apart — a "…" that
 * hides a single row hides nothing.
 */
export function leaderboardSegments(total: number, focus: number | null, top = 10, radius = 2): [number, number][] {
  const ranges: [number, number][] = [[0, Math.min(top, total)]];
  if (focus !== null && focus >= 0 && focus < total) {
    ranges.push([Math.max(0, focus - radius), Math.min(total, focus + radius + 1)]);
  }
  const out: [number, number][] = [];
  for (const [start, end] of ranges) {
    if (end <= start) continue;
    const last = out[out.length - 1];
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
    else out.push([start, end]);
  }
  return out;
}

/**
 * The share of the rest of the field a trader is strictly ahead of, as a
 * whole percentage rounded down, so it never flatters. `below` is how many
 * traders score strictly lower; ties are not beaten. `null` for a field of
 * one, where there is nobody to be ahead of.
 */
export function percentAhead(below: number, fieldSize: number): number | null {
  if (fieldSize <= 1) return null;
  return Math.floor((100 * below) / (fieldSize - 1));
}
