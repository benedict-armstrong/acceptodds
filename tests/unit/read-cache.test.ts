import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReadCache } from '@/server/read-cache';

afterEach(() => vi.useRealTimers());

describe('public read cache', () => {
  it('shares concurrent work, expires, and retries failures', async () => {
    vi.useFakeTimers();
    const cache = new ReadCache();
    const compute = vi.fn().mockResolvedValue(1);
    const a = cache.get('board', 1000, compute);
    const b = cache.get('board', 1000, compute);
    expect(a).toBe(b);
    await expect(a).resolves.toBe(1);
    expect(compute).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    await cache.get('board', 1000, compute);
    expect(compute).toHaveBeenCalledTimes(2);
    const failure = vi.fn().mockRejectedValueOnce(new Error('database unavailable')).mockResolvedValue(2);
    await expect(cache.get('tape', 1000, failure)).rejects.toThrow('database unavailable');
    await expect(cache.get('tape', 1000, failure)).resolves.toBe(2);
  });

  it('invalidates one market, including in-flight reads, without evicting others', async () => {
    const cache = new ReadCache();
    let complete!: (value: number) => void;
    const old = cache.get(
      'a',
      1000,
      () =>
        new Promise<number>((resolve) => {
          complete = resolve;
        }),
      ['a'],
    );
    const other = cache.get('b', 1000, async () => 2, ['b']);
    await Promise.resolve();
    cache.invalidate('a');
    const fresh = cache.get('a', 1000, async () => 3, ['a']);
    complete(1);
    await expect(old).resolves.toBe(1);
    await expect(fresh).resolves.toBe(3);
    expect(cache.get('a', 1000, async () => 4, ['a'])).toBe(fresh);
    expect(cache.get('b', 1000, async () => 4, ['b'])).toBe(other);
  });

  it('bounds memory and clears all entries', async () => {
    const cache = new ReadCache(2);
    const first = await cache.get('a', 1000, async () => 1);
    await cache.get('b', 1000, async () => 2);
    await cache.get('c', 1000, async () => 3);
    expect(await cache.get('a', 1000, async () => 4)).not.toBe(first);
    cache.clear();
    expect(await cache.get('a', 1000, async () => 5)).toBe(5);
  });
});
