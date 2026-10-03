import { describe, expect, it } from 'vitest';
import { siteShareLinks } from '@/lib/invite';

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
