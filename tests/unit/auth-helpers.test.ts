import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { handleFrom } from '@/server/accounts';
import { mapOrcidProfile } from '@/server/better-auth';
import { buildRorIndex, institutionForDomain } from '@/server/ror';

const dump = JSON.parse(readFileSync('tests/fixtures/ror-dump.json', 'utf8'));
const index = buildRorIndex(dump, 'fixture');

describe('ROR index', () => {
  it('maps active organisations by domain, falling back to the website host', () => {
    expect(index.domains['ethz.ch']).toEqual(['https://ror.org/05a28rw58', 'ETH Zurich']);
    expect(index.domains['ox.ac.uk']).toEqual(['https://ror.org/052gg0110', 'University of Oxford']);
  });

  it('drops inactive organisations and domains claimed by more than one', () => {
    expect(index.domains['defunct.edu']).toBeUndefined();
    expect(index.domains['shared.org']).toBeUndefined();
  });

  it('matches subdomains, never a bare public suffix', () => {
    expect(institutionForDomain('inf.ethz.ch', index)?.name).toBe('ETH Zurich');
    expect(institutionForDomain('ETHZ.CH.', index)?.name).toBe('ETH Zurich');
    expect(institutionForDomain('cs.ox.ac.uk', index)?.name).toBe('University of Oxford');
    expect(institutionForDomain('ac.uk', index)).toBeNull();
    expect(institutionForDomain('gmail.com', index)).toBeNull();
    expect(institutionForDomain('ch', index)).toBeNull();
  });
});

describe('ORCID profile mapping', () => {
  it('uses the public email when ORCID releases one', () => {
    expect(mapOrcidProfile({ sub: '0000-0002-1825-0097', name: 'Josiah Carberry', email: 'j@brown.edu' })).toEqual({
      name: 'Josiah Carberry',
      email: 'j@brown.edu',
      emailVerified: false,
    });
  });

  it('gives an iD without an email an undeliverable, unverified placeholder', () => {
    expect(
      mapOrcidProfile({ sub: '0000-0002-1825-0097', given_name: 'Josiah', family_name: 'Carberry' }),
    ).toEqual({ name: 'Josiah Carberry', email: '0000-0002-1825-0097@orcid.invalid', emailVerified: false });
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
