/**
 * ICLR's bibliography style (natbib, `iclr20xx_conference.bst`), for a
 * paper's back matter (#38). Client-safe.
 *
 * Every author in full, "A and B", "A, B, and C"; entries alphabetical by
 * the first author's surname, then year, then title. An entry with no
 * authors (an anonymous submission) sorts by its title, as BibTeX does.
 */

export interface BibEntry {
  authors: readonly string[];
  year: number | null;
  title: string;
}

/** "A", "A and B", "A, B, and C". */
export function authorList(names: readonly string[]): string {
  if (names.length <= 2) return names.join(' and ');
  return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;
}

const SUFFIX = /^(jr|sr|ii|iii|iv)\.?$/i;

/** A name's surname for sorting: its last word, past a "Jr." or "III", without accents. */
export function surname(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  while (words.length > 1 && SUFFIX.test(words[words.length - 1].replace(/,$/, ''))) words.pop();
  return fold(words[words.length - 1] ?? '');
}

function fold(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N} ]/gu, '')
    .toLowerCase();
}

/** The entries in bibliography order. Stable, and never mutates its input. */
export function bibOrder<T extends BibEntry>(entries: readonly T[]): T[] {
  const key = (e: T) => (e.authors.length > 0 ? surname(e.authors[0]) : fold(e.title));
  return entries
    .map((e, i) => ({ e, i, k: key(e) }))
    .sort(
      (a, b) =>
        a.k.localeCompare(b.k) ||
        (a.e.year ?? Infinity) - (b.e.year ?? Infinity) ||
        fold(a.e.title).localeCompare(fold(b.e.title)) ||
        a.i - b.i,
    )
    .map((x) => x.e);
}
