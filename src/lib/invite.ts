/** A BibTeX field value: `& % # _ \ { }` are escaped so the entry compiles. */
function bibEscape(text: string): string {
  return text.replace(/[\\&%#_{}]/g, (c) => (c === '\\' ? '\\textbackslash{}' : `\\${c}`));
}

/**
 * What the first-trade prompt hands over to share the site itself: a BibTeX
 * `@misc` entry, as a paper's share button does for a paper (`shareText`),
 * keyed by the site's name. The site's link only: nothing of the trader's.
 */
export function siteCitation(s: { name: string; url: string; year: number }): string {
  const fields: [string, string][] = [
    ['title', bibEscape(`${s.name}: a market for paper decisions`)],
    ['howpublished', `\\url{${s.url}}`],
    ['year', String(s.year)],
  ];
  const width = Math.max(...fields.map(([k]) => k.length));
  const body = fields.map(([k, v]) => `  ${k.padEnd(width)} = {${v}}`).join(',\n');
  return `@misc{${s.name.toLowerCase().replace(/[^\w.:-]/g, '-')},\n${body}\n}`;
}
