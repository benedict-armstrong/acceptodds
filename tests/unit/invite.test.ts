import { describe, expect, it } from 'vitest';
import { siteCitation, siteShareLinks } from '@/lib/invite';

describe('siteCitation', () => {
  it('is a BibTeX @misc keyed by the site, with its link', () => {
    expect(siteCitation({ name: 'acceptodds', url: 'https://acceptodds.com', year: 2026 })).toBe(
      [
        '@misc{acceptodds,',
        '  title        = {acceptodds: a market for paper decisions},',
        '  howpublished = {\\url{https://acceptodds.com}},',
        '  year         = {2026}',
        '}',
      ].join('\n'),
    );
  });

  it('escapes what would stop the entry compiling, and keys safely', () => {
    const out = siteCitation({ name: 'accept_odds & co', url: 'https://x.test', year: 2026 });
    expect(out).toContain('accept\\_odds \\& co');
    expect(out.startsWith('@misc{accept_odds-')).toBe(true);
  });
});

describe('siteShareLinks', () => {
  it("prefills each service's share page with the invitation and the site's link", () => {
    const { x, whatsapp } = siteShareLinks({ name: 'acceptodds', venue: 'ICLR 2027', url: 'https://acceptodds.com' });
    const text =
      'Want to know if your paper will get into ICLR 2027? I just made my first trade on acceptodds, check it out!';
    const xUrl = new URL(x);
    expect(xUrl.origin + xUrl.pathname).toBe('https://x.com/intent/post');
    expect(xUrl.searchParams.get('text')).toBe(text);
    expect(xUrl.searchParams.get('url')).toBe('https://acceptodds.com');
    const wa = new URL(whatsapp);
    expect(wa.origin).toBe('https://wa.me');
    expect(wa.searchParams.get('text')).toBe(`${text} https://acceptodds.com`);
  });
});
