import { describe, expect, it } from 'vitest';
import { authorList, bibOrder, surname } from '@/lib/bibliography';

describe('authorList', () => {
  it('joins as ICLR does', () => {
    expect(authorList([])).toBe('');
    expect(authorList(['A'])).toBe('A');
    expect(authorList(['A', 'B'])).toBe('A and B');
    expect(authorList(['A', 'B', 'C'])).toBe('A, B, and C');
  });
});

describe('surname', () => {
  it('takes the last word, past suffixes and accents', () => {
    expect(surname('Ashish Vaswani')).toBe('vaswani');
    expect(surname('D. E. Rumelhart')).toBe('rumelhart');
    expect(surname('Martin Luther King Jr.')).toBe('king');
    expect(surname('Kurt Gödel')).toBe('godel');
    expect(surname('Plato')).toBe('plato');
  });
});

describe('bibOrder', () => {
  it('sorts by first surname, then year, then title; authorless by title', () => {
    const e = (title: string, authors: string[], year: number | null = null) => ({ title, authors, year });
    const sorted = bibOrder([
      e('Z', ['Ashish Vaswani'], 2017),
      e('Learning', ['D. E. Rumelhart'], 1986),
      e('Adam', ['D. P. Kingma', 'J. Ba'], 2014),
      e('Later', ['D. P. Kingma'], 2020),
      e('Earlier', ['D. P. Kingma'], 2013),
      e('Mamba', []),
    ]);
    expect(sorted.map((x) => x.title)).toEqual(['Earlier', 'Adam', 'Later', 'Mamba', 'Learning', 'Z']);
  });
});
