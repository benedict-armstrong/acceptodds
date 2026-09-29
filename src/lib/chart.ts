/**
 * The index of the point in force at `ms` on a step chart: the last one at or
 * before it, since a price holds until the next fill changes it. Before the
 * first point, the first. `times` ascending, in ms.
 */
export function stepIndexAt(times: number[], ms: number): number {
  let lo = 0;
  let hi = times.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (times[mid] <= ms) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}
