/**
 * The leaderboard's search syntax: a name, plus `institution:` filters.
 * Pure and client-safe.
 *
 *     ada institution:eth -institution:"ETH Zurich"
 *
 * `institution:x` (aliases `inst:`, `i:`) keeps traders with an institution
 * containing `x`, case-insensitively; `-institution:x` or `institution!=x`
 * keeps those with none. Several filters all apply. Everything else is the
 * name, searched as before (`views.matchingTraders`). A key that is not
 * `institution` is part of the name. The filters only narrow the board: every
 * row keeps its rank in the field.
 */

const ALIASES = new Set(['institution', 'inst', 'i']);
const FIELD = /^(-?)([A-Za-z]+)(!=|:|=)/;

export interface TraderSearch {
  /** The name to look for, `null` when only filters are left. */
  name: string | null;
  include: string[];
  exclude: string[];
  /** One line per term that was dropped, for the page to show. */
  errors: string[];
}

export function parseTraderSearch(input: string): TraderSearch {
  const words: string[] = [];
  const include: string[] = [];
  const exclude: string[] = [];
  const errors: string[] = [];
  let i = 0;
  const n = input.length;
  const isSpace = (c: string) => /\s/.test(c);
  // A run up to whitespace, or a quoted one; unterminated quotes run to the end.
  const value = () => {
    if (input[i] === '"') {
      const end = input.indexOf('"', i + 1);
      const text = input.slice(i + 1, end < 0 ? n : end);
      i = end < 0 ? n : end + 1;
      return text;
    }
    const start = i;
    while (i < n && !isSpace(input[i])) i += 1;
    return input.slice(start, i);
  };

  while (i < n) {
    if (isSpace(input[i])) {
      i += 1;
      continue;
    }
    const start = i;
    const head = FIELD.exec(input.slice(i));
    if (head && ALIASES.has(head[2].toLowerCase())) {
      i += head[0].length;
      const v = value().trim();
      if (v === '') errors.push(`“${input.slice(start, i)}”: no value`);
      else ((head[1] === '-') !== (head[3] === '!=') ? exclude : include).push(v);
    } else {
      const w = value();
      if (w !== '') words.push(w);
    }
  }
  const name = words.join(' ').trim();
  return { name: name === '' ? null : name, include, exclude, errors };
}

/** Whether a trader's institutions pass the search's filters. */
export function institutionsMatch(institutions: readonly string[], search: Pick<TraderSearch, 'include' | 'exclude'>): boolean {
  const has = (v: string) => institutions.some((name) => name.toLowerCase().includes(v.toLowerCase()));
  return search.include.every(has) && !search.exclude.some(has);
}
