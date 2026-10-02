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
    ['title', bibEscape(sitePitch(s.name))],
    ['howpublished', `\\url{${s.url}}`],
    ['year', String(s.year)],
  ];
  const width = Math.max(...fields.map(([k]) => k.length));
  const body = fields.map(([k, v]) => `  ${k.padEnd(width)} = {${v}}`).join(',\n');
  return `@misc{${s.name.toLowerCase().replace(/[^\w.:-]/g, '-')},\n${body}\n}`;
}

/** The site in one line: the title of its BibTeX entry. */
export function sitePitch(name: string): string {
  return `${name}: a market for paper decisions`;
}

/** What the first-trade prompt's share buttons post, before the site's link: an invitation to try it. */
export function shareMessage(s: { name: string; venue: string }): string {
  return `Want to know if your paper will get into ${s.venue}? I just made my first trade on ${s.name}, check it out!`;
}

/**
 * Where the first-trade prompt's share buttons go: each service's own share
 * page, prefilled with the message and the site's link. Plain links, so no
 * third-party script is loaded and nothing is posted until the person does.
 */
export function siteShareLinks(s: { name: string; venue: string; url: string }): { x: string; whatsapp: string } {
  const text = shareMessage(s);
  return {
    x: `https://x.com/intent/post?${new URLSearchParams({ text, url: s.url })}`,
    whatsapp: `https://wa.me/?${new URLSearchParams({ text: `${text} ${s.url}` })}`,
  };
}
