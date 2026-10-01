import { describe, expect, it } from 'vitest';
import { siteCitation } from '@/lib/invite';

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
