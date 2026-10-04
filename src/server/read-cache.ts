/** Bounded, in-process public read cache. Transactions must bypass it. */
export class ReadCache {
  private entries = new Map<string, { at: number; tags: readonly string[]; value: Promise<unknown> }>();

  constructor(private readonly capacity = 500) {}

  get<T>(key: string, ttlMs: number, compute: () => Promise<T>, tags: readonly string[] = []): Promise<T> {
    const hit = this.entries.get(key);
    if (hit && Date.now() - hit.at < ttlMs) return hit.value as Promise<T>;
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

  clear(): void {
    this.entries.clear();
  }
}
