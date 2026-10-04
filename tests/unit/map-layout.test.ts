import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { relatedGroups, settleAround } from '@/lib/map-layout';
import { MAP_SIZE } from '@/lib/map';

const last = <T>(frames: Generator<T>): T => {
  let out: T | undefined;
  for (const f of frames) out = f;
  return out!;
};

/** A piece of a map: `n` points scattered by `seed`. */
function piece(n: number, seed: number): Float32Array {
  let s = seed;
  return Float32Array.from({ length: 2 * n }, () => ((s = (s * 16807) % 2147483647) / 2147483647) * 100);
}

/** Every pair within each of `cliques` (lists of indexes), as related pairs. */
const tie = (cliques: number[][]): [number, number][] =>
  cliques.flatMap((c) => c.flatMap((a) => c.filter((b) => b !== a).map((b) => [a, b] as [number, number])));

describe('relatedGroups', () => {
  it('finds papers that name each other as groups, leaves the centre out and folds strays into the nearest', () => {
    // 0 is the centre; 1–5 and 6–10 name each other; 11 names no one and sits by 6–10 on the map.
    const positions = Float32Array.from([
      50,
      50,
      ...[1, 2, 3, 4, 5].flatMap((k) => [k, 0]),
      ...[1, 2, 3, 4, 5].flatMap((k) => [90 + k, 90]),
      97,
      90,
    ]);
    const g = relatedGroups(
      positions,
      [
        ...tie([
          [1, 2, 3, 4, 5],
          [6, 7, 8, 9, 10],
        ]),
        [0, 1],
      ],
      0,
    );
    expect(g[0]).toBe(-1);
    expect(new Set([1, 2, 3, 4, 5].map((i) => g[i])).size).toBe(1);
    expect(new Set([6, 7, 8, 9, 10, 11].map((i) => g[i])).size).toBe(1);
    expect(g[1]).not.toBe(g[6]);
  });

  it('puts everything in one group when no group is big enough', () => {
    const g = relatedGroups(piece(6, 3), [[1, 2]], 0);
    expect([...g]).toEqual([-1, 0, 0, 0, 0, 0]);
  });
});

describe('settleAround', () => {
  it('keeps the paper at the centre and each group tighter than the piece, deterministically', () => {
    const start = piece(40, 7);
    const groups = [
      Array.from({ length: 13 }, (_, k) => k + 1),
      Array.from({ length: 13 }, (_, k) => k + 14),
      Array.from({ length: 13 }, (_, k) => k + 27),
    ];
    const related = tie(groups);
    const out = last(settleAround(start, 0, [1, 14, 27], related));
    expect([out[0], out[1]]).toEqual([MAP_SIZE / 2, MAP_SIZE / 2]);
    const d = (a: number, b: number) => Math.hypot(out[2 * a] - out[2 * b], out[2 * a + 1] - out[2 * b + 1]);
    const mean = (pairs: [number, number][]) => pairs.reduce((s, [a, b]) => s + d(a, b), 0) / pairs.length;
    const inside = groups.flatMap((g) =>
      g.flatMap((a) => g.filter((b) => b > a).map((b) => [a, b] as [number, number])),
    );
    const across = groups[0].flatMap((a) => [...groups[1], ...groups[2]].map((b) => [a, b] as [number, number]));
    expect(mean(inside)).toBeLessThan(mean(across) / 2);
    expect(last(settleAround(start, 0, [1, 14, 27], related))).toEqual(out);
  });

  it('gives every paper a finite place of its own, whatever the ties', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 3, max: 80 }),
        fc.integer({ min: 1, max: 1e6 }),
        fc.array(fc.tuple(fc.nat(), fc.nat()), { maxLength: 200 }),
        (n, seed, pairs) => {
          const related = pairs.map(([a, b]) => [a % n, b % n] as [number, number]);
          const out = last(
            settleAround(
              piece(n, seed),
              0,
              [1, 2].filter((i) => i < n),
              related,
            ),
          );
          expect(out.every(Number.isFinite)).toBe(true);
          for (let a = 0; a < n; a++)
            for (let b = a + 1; b < n; b++)
              expect(Math.hypot(out[2 * a] - out[2 * b], out[2 * a + 1] - out[2 * b + 1])).toBeGreaterThan(1);
        },
      ),
      { numRuns: 30 },
    );
  });
});
