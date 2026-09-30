import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { ANALYTICS_PARAMS, analyticsUrl } from '@/lib/analytics';

const ORIGIN = 'https://acceptodds.com';

describe('analyticsUrl', () => {
  it('drops the email on /confirm and the return path', () => {
    expect(analyticsUrl(`${ORIGIN}/confirm?email=a%40mit.edu&next=%2Fportfolio&resent=1`, ORIGIN)).toBe(
      `${ORIGIN}/confirm?resent=1`,
    );
  });

  it('keeps the browsing state, in order', () => {
    const url = `${ORIGIN}/?q=diffusion&kind=ICLR+2027&sort=volume&page=3`;
    expect(analyticsUrl(url, ORIGIN)).toBe(url);
  });

  it('drops the hash', () => {
    expect(analyticsUrl(`${ORIGIN}/papers/x#comments`, ORIGIN)).toBe(`${ORIGIN}/papers/x`);
  });

  it('keeps only origin and path of another site', () => {
    expect(analyticsUrl('https://news.example/item?id=1&q=secret#c', ORIGIN)).toBe('https://news.example/item');
  });

  it('strips credentials and returns empty for garbage', () => {
    expect(analyticsUrl('https://u:p@other.example/', ORIGIN)).toBe('https://other.example/');
    expect(analyticsUrl('http://[', ORIGIN)).toBe('');
  });

  it('never lets an unlisted parameter through', () => {
    const key = fc.stringMatching(/^[a-z_]{1,12}$/).filter((k) => !ANALYTICS_PARAMS.has(k));
    fc.assert(
      fc.property(key, fc.string(), (k, v) => {
        const url = new URL(`${ORIGIN}/confirm`);
        url.searchParams.set(k, v);
        url.searchParams.set('page', '2');
        const out = new URL(analyticsUrl(url.toString(), ORIGIN));
        expect(out.searchParams.has(k)).toBe(false);
        expect(out.searchParams.get('page')).toBe('2');
      }),
    );
  });
});
