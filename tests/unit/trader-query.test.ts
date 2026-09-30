import { describe, expect, it } from 'vitest';
import { institutionsMatch, parseTraderSearch } from '@/lib/trader-query';

describe('parseTraderSearch', () => {
  it('is only a name without filters', () => {
    expect(parseTraderSearch('  ada lovelace ')).toEqual({ name: 'ada lovelace', include: [], exclude: [], errors: [] });
  });

  it('reads institution filters, aliases, quotes and negation', () => {
    expect(parseTraderSearch('ada institution:eth Inst:"ETH Zurich" -i:epfl institution!=mit')).toEqual({
      name: 'ada',
      include: ['eth', 'ETH Zurich'],
      exclude: ['epfl', 'mit'],
      errors: [],
    });
  });

  it('leaves only filters with no name', () => {
    expect(parseTraderSearch('institution:eth').name).toBeNull();
  });

  it('treats another key as part of the name', () => {
    expect(parseTraderSearch('title:foo bar').name).toBe('title:foo bar');
  });

  it('drops an empty filter with an error', () => {
    const s = parseTraderSearch('institution: ada');
    expect(s.include).toEqual([]);
    expect(s.name).toBe('ada');
    expect(s.errors).toEqual(['“institution:”: no value']);
  });
});

describe('institutionsMatch', () => {
  const eth = ['ETH Zurich', 'University of Basel'];
  it('matches any institution by substring, case-insensitively', () => {
    expect(institutionsMatch(eth, { include: ['zurich'], exclude: [] })).toBe(true);
    expect(institutionsMatch(eth, { include: ['zurich', 'basel'], exclude: [] })).toBe(true);
    expect(institutionsMatch(eth, { include: ['epfl'], exclude: [] })).toBe(false);
  });

  it('excludes a trader with any matching institution', () => {
    expect(institutionsMatch(eth, { include: [], exclude: ['basel'] })).toBe(false);
    expect(institutionsMatch([], { include: [], exclude: ['basel'] })).toBe(true);
  });
});
