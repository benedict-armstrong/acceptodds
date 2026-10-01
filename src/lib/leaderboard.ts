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
 * Where a net worth of `mine` falls in `sortedWorths` (ascending): rank as
 * the leaderboard ranks (one more than how many are strictly higher, so ties
 * share it) and the share of the others strictly below. For placing a
 * viewer's live figure on a snapshot of the field (`field_snapshots`), which
 * may be minutes old and holds the viewer's own older figure too, so the
 * result can be one place out: fine for "where you stand", never for the
 * leaderboard's ranks.
 */
export function placeIn(
  sortedWorths: readonly bigint[],
  mine: bigint,
  digits = 0,
): { rank: number; fieldSize: number; percentAhead: number | null } {
  let below = 0;
  let above = 0;
  for (const w of sortedWorths) {
    if (w < mine) below += 1;
    else if (w > mine) above += 1;
  }
  const rank = above + 1;
  // Below everyone in an older snapshot is still a place on the board, not "#6 of 5".
  const fieldSize = Math.max(sortedWorths.length, rank);
  return { rank, fieldSize, percentAhead: percentAhead(below, fieldSize, digits) };
}

/**
 * The share of the rest of the field a trader is strictly ahead of, as a
 * percentage rounded down (to `digits` decimals, whole by default), so it never flatters. `below` is how many
 * traders score strictly lower; ties are not beaten. `null` for a field of
 * one, where there is nobody to be ahead of.
 */
export function percentAhead(below: number, fieldSize: number, digits = 0): number | null {
  if (fieldSize <= 1) return null;
  const scale = 10 ** digits;
  return Math.floor((100 * scale * below) / (fieldSize - 1)) / scale;
}

/**
 * `percentAhead` as a band: "Top 4%" from the half-way line up, "Bottom 4%"
 * below it. Never 0%: the extremes read "Top 1%" / "Bottom 1%".
 */
export function standingBand(percentAhead: number): string {
  const top = percentAhead >= 50;
  return `${top ? 'Top' : 'Bottom'} ${Math.max(1, Math.ceil(top ? 100 - percentAhead : percentAhead))}%`;
}
