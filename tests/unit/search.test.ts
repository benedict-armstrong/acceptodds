import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { normalizeSearch, prefixTsquery, SEARCH_MAX_LENGTH } from '@/lib/search';

describe('normalizeSearch', () => {
  it('treats missing and blank as no search', () => {
    expect(normalizeSearch(undefined)).toBeNull();
    expect(normalizeSearch(null)).toBeNull();
    expect(normalizeSearch('')).toBeNull();
    expect(normalizeSearch(' \t\n ')).toBeNull();
    expect(normalizeSearch('\u0000')).toBeNull();
  });

  it('trims, collapses whitespace, strips control characters, truncates', () => {
    expect(normalizeSearch('  graph   neural\tnets ')).toBe('graph neural nets');
    expect(normalizeSearch('nul\u0000byte')).toBe('nul byte');
    expect(normalizeSearch('x'.repeat(500))).toHaveLength(SEARCH_MAX_LENGTH);
  });

  it('is idempotent and never returns a control character', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 400 }), (s) => {
        const n = normalizeSearch(s);
        if (n === null) return;
        expect(normalizeSearch(n)).toBe(n);
        expect(n.length).toBeLessThanOrEqual(SEARCH_MAX_LENGTH);
        expect(/[\u0000-\u001f\u007f]/.test(n)).toBe(false);
      }),
    );
  });
});

describe('prefixTsquery', () => {
  it('ANDs the words and prefixes the last', () => {
    expect(prefixTsquery('transf')).toBe('transf:*');
    expect(prefixTsquery('attention is all you ne')).toBe('attention & is & all & you & ne:*');
    expect(prefixTsquery("don't-stop, café!")).toBe('don & t & stop & café:*');
  });

  it('steps aside for websearch operators', () => {
    expect(prefixTsquery('"a phrase"')).toBeNull();
    expect(prefixTsquery('graph -neural')).toBeNull();
    expect(prefixTsquery('-neural')).toBeNull();
    expect(prefixTsquery('graph OR tree')).toBeNull();
    expect(prefixTsquery('graph or tree')).toBeNull();
    // Not operators: a hyphen inside a word, "or" inside a word.
    expect(prefixTsquery('state-of-the-art')).toBe('state & of & the & art:*');
    expect(prefixTsquery('oracle')).toBe('oracle:*');
  });

  it('is null when there is no word', () => {
    expect(prefixTsquery('&|!:*()')).toBeNull();
  });

  it('only ever emits words, `&` and one trailing `:*`', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (s) => {
        const t = prefixTsquery(s);
        if (t === null) return;
        expect(t).toMatch(/^([\p{L}\p{M}\p{N}]+ & )*[\p{L}\p{M}\p{N}]+:\*$/u);
      }),
    );
  });
});
