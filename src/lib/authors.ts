/**
 * A paper's author block: each distinct affiliation gets a number in order
 * of first appearance down the author list, and each author the numbers of
 * theirs ("Ada¹ ², Grace²" over "¹ ETH Zurich ² MIT").
 */
export function numberAffiliations(authors: readonly { affiliations: readonly string[] }[]): {
  /** Affiliation `i` is numbered `i + 1`. */
  affiliations: string[];
  /** Per author, the numbers of their affiliations, in their own order. */
  marks: number[][];
} {
  const index = new Map<string, number>();
  const marks = authors.map((a) =>
    a.affiliations.map((name) => {
      let n = index.get(name);
      if (n === undefined) {
        n = index.size + 1;
        index.set(name, n);
      }
      return n;
    }),
  );
  return { affiliations: [...index.keys()], marks };
}
