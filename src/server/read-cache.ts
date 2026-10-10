/** Bounded, in-process public read cache. Transactions must bypass it. */
export class ReadCache {
  private entries = new Map<string, { at: number; tags: readonly string[]; value: Promise<unknown>; until?: number }>();

  constructor(private readonly capacity = 500) {}

  get<T>(key: string, ttlMs: number, compute: () => Promise<T>, tags: readonly string[] = []): Promise<T> {
    const hit = this.entries.get(key);
    const now = Date.now();
    if (hit && now - hit.at < ttlMs && !(hit.until !== undefined && now >= hit.until)) return hit.value as Promise<T>;
    const entry = { at: Date.now(), tags, value: Promise.resolve().then(compute) };
    this.entries.delete(key);
    this.entries.set(key, entry);
    if (this.entries.size > this.capacity) this.entries.delete(this.entries.keys().next().value!);
    entry.value.catch(() => {
      if (this.entries.get(key) === entry) this.entries.delete(key);
    });
    return entry.value;
  }

  invalidate(tag: string): void {
    for (const [key, entry] of this.entries) if (entry.tags.includes(tag)) this.entries.delete(key);
  }

  /**
   * Every entry, in flight or not, is served for at most `ms` more: a write
   * that may leave them stale, where a few seconds of staleness is fine and a
   * recompute after every write is not. `ms <= 0` is `clear()`.
   */
  expireWithin(ms: number): void {
    if (ms <= 0) return this.clear();
    const until = Date.now() + ms;
    for (const entry of this.entries.values()) entry.until = Math.min(entry.until ?? until, until);
  }

  clear(): void {
    this.entries.clear();
  }
}
