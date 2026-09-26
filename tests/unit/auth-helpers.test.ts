import { describe, expect, it } from 'vitest';
import { handleFrom } from '@/server/accounts';
import { institutionForEmail } from '@/server/institution-domains';

describe('institution allowlist', () => {
  it('matches a listed domain and its subdomains, case-insensitively', () => {
    expect(institutionForEmail('ada@ethz.ch')).toEqual({ domain: 'ethz.ch', name: 'ETH Zurich' });
    expect(institutionForEmail('ada@inf.ETHZ.ch')).toEqual({ domain: 'ethz.ch', name: 'ETH Zurich' });
    expect(institutionForEmail('ada@example.org.')).toEqual({ domain: 'example.org', name: 'Example University' });
  });

  it('refuses unlisted domains, lookalikes and a bare TLD even if it is listed', () => {
    expect(institutionForEmail('ada@gmail.com')).toBeNull();
    expect(institutionForEmail('ada@notethz.ch')).toBeNull();
    expect(institutionForEmail('ada@ethz.ch.evil.com')).toBeNull();
    expect(institutionForEmail('ada@oxford.uk')).toBeNull();
    expect(institutionForEmail('not-an-email')).toBeNull();
  });
});

describe('handleFrom', () => {
  it('slugs a name, then an email, then falls back', () => {
    expect(handleFrom('Ada Lovelace', 'x@y.z')).toBe('ada-lovelace');
    expect(handleFrom('Émile Borel', 'x@y.z')).toBe('emile-borel');
    expect(handleFrom('李', 'grace.hopper@navy.mil')).toBe('grace-hopper');
    expect(handleFrom('', 'a@b.c')).toBe('trader');
    expect(handleFrom('House', 'h@b.c')).toBe('house-trader');
    expect(handleFrom('x'.repeat(50), 'a@b.c')).toHaveLength(30);
  });
});
