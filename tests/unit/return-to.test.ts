import { describe, expect, it } from 'vitest';
import { authHref, safeReturnTo } from '@/lib/return-to';

describe('safeReturnTo', () => {
  it('keeps a same-site path with its query', () => {
    expect(safeReturnTo('/papers/foo?market=bar')).toBe('/papers/foo?market=bar');
    expect(safeReturnTo(['/portfolio', '/x'])).toBe('/portfolio');
  });

  it.each([
    [undefined],
    [''],
    ['https://evil.example/'],
    ['//evil.example'],
    ['/\\evil.example'],
    ['/\t/evil.example'],
    ['/\n/evil.example'],
    ['javascript:alert(1)'],
    ['papers/foo'],
    ['/signin'],
    ['/verify-email?next=/x'],
    ['/verify-email'],
    ['/x'.repeat(1001)],
  ])('falls back to / for %j', (raw) => {
    expect(safeReturnTo(raw)).toBe('/');
  });

  it('does not mistake a page that merely starts with an auth name for one', () => {
    expect(safeReturnTo('/signing-guide')).toBe('/signing-guide');
  });
});

describe('authHref', () => {
  it('adds next only when it is not the home page', () => {
    expect(authHref('/signin', '/')).toBe('/signin');
    expect(authHref('/signin', '//evil')).toBe('/signin');
    expect(authHref('/signin', '/papers/a?market=b')).toBe('/signin?next=%2Fpapers%2Fa%3Fmarket%3Db');
    expect(authHref('/verify-email', '/p', { email: 'a@b.org' })).toBe('/verify-email?email=a%40b.org&next=%2Fp');
  });
});
