import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ALIAS_ALPHABET, mentionedAliases, randomAlias, splitMentions } from '@/lib/aliases';

describe('randomAlias', () => {
  it('is four characters of the alphabet, without look-alikes', () => {
    fc.assert(
      fc.property(
        fc.array(fc.double({ min: 0, max: 1, maxExcluded: true, noNaN: true }), { minLength: 4, maxLength: 4 }),
        (rs) => {
          let i = 0;
          const a = randomAlias(() => rs[i++]);
          expect(a).toHaveLength(4);
          for (const ch of a) expect(ALIAS_ALPHABET).toContain(ch);
        },
      ),
    );
    expect(ALIAS_ALPHABET).not.toMatch(/[01ilo]/);
  });
});

describe('mentions', () => {
  it('are @ and four characters, standing alone, lower-cased, once each', () => {
    expect(mentionedAliases('@k3xm agrees with @AB2C, and @k3xm again')).toEqual(['k3xm', 'ab2c']);
    expect(mentionedAliases('(@k3xm) @k3xm.')).toEqual(['k3xm']);
  });

  it('are not an address, a longer word or a double @', () => {
    expect(mentionedAliases('ada@k3xm a.b@k3xm @k3xmz @@k3xm @k3x @k3xm@x')).toEqual([]);
  });

  it('split a text at the known ones only, keeping every character', () => {
    const text = 'cc @K3XM and @zzzz, then @k3xm';
    const parts = splitMentions(text, new Set(['k3xm']));
    expect(parts).toEqual([
      'cc ',
      { alias: 'k3xm', text: '@K3XM' },
      ' and @zzzz, then ',
      { alias: 'k3xm', text: '@k3xm' },
    ]);
    expect(parts.map((p) => (typeof p === 'string' ? p : p.text)).join('')).toBe(text);
  });

  it('never lose or reorder text', () => {
    fc.assert(
      fc.property(fc.string(), fc.constantFrom('abcd', 'k3xm'), (s, alias) => {
        const text = `${s} @${alias} ${s}`;
        const parts = splitMentions(text, new Set([alias]));
        expect(parts.map((p) => (typeof p === 'string' ? p : p.text)).join('')).toBe(text);
      }),
    );
  });
});
