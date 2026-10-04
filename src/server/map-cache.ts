/**
 * An in-process cache for the paper map's public reads (`GET /map`,
 * `/map/related`, `/listings/{id}/minimap`), which are each a pass over a
 * whole table and are read by every visitor alike.
 *
 * Like `standings-cache.ts`: a generation that the map's writers — `setMap`,
 * `setRelated` and `upsertListing` (a slug becomes listed, a title changes) —
 * bump **after their commit**. An entry computed under an older generation is
 * never served. Headlines move with every trade and bump nothing: they are
 * covered by each entry's TTL alone, as the responses' `max-age` already
 * lets a browser keep them that long.
 *
 * In-process, which is correct for the single app container of §11. Writers
 * outside the process are covered only by the TTL. Only reads on the shared
 * database go through it; a caller with a transaction reads past it.
 */

/** Entries kept at most; the oldest goes first. One per minimap viewed, so bounded. */
const MAX_ENTRIES = 500;

let generation = 0;
const entries = new Map<string, { generation: number; at: number; value: Promise<unknown> }>();

/** After a commit that changes what the map shows. Also drops a computation still running: it read the old map. */
export function invalidateMap(): void {
  generation += 1;
  entries.clear();
}

/**
 * `compute()`'s value for `key`, from the cache when no map write has
 * committed since and it is younger than `ttlMs`. Concurrent readers share
 * one computation; a failure is not cached.
 */
export function mapCached<T>(key: string, ttlMs: number, compute: () => Promise<T>): Promise<T> {
  const hit = entries.get(key);
  if (hit && hit.generation === generation && Date.now() - hit.at < ttlMs) return hit.value as Promise<T>;
  const entry = { generation, at: Date.now(), value: compute() };
  entries.delete(key);
  entries.set(key, entry);
  if (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value!);
  entry.value.catch(() => {
    if (entries.get(key) === entry) entries.delete(key);
  });
  return entry.value;
}
