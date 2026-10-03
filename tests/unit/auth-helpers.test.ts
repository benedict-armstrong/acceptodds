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

  it('refuses a +tag on a listed domain: one inbox, one account', () => {
    expect(institutionForEmail('ada+x@ethz.ch')).toBeNull();
  });
});

describe('handleFrom', () => {
  it('slugs a name, else falls back, and never reads the email', () => {
    expect(handleFrom('Ada Lovelace')).toBe('ada-lovelace');
    expect(handleFrom('Émile Borel')).toBe('emile-borel');
    expect(handleFrom('李')).toBe('trader');
    expect(handleFrom('')).toBe('trader');
    expect(handleFrom(null)).toBe('trader');
    expect(handleFrom('House')).toBe('house-trader');
    expect(handleFrom('x'.repeat(50))).toHaveLength(30);
  });
});
