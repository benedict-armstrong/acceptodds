import { describe, expect, it } from 'vitest';
import { splitMath } from '@/lib/math-text';

describe('splitMath', () => {
  it('splits inline and display math, both inline', () => {
    expect(splitMath('An $O(\\sqrt{n})$ bound and $$x^2$$.')).toEqual([
      { math: false, text: 'An ' },
      { math: true, tex: 'O(\\sqrt{n})' },
      { math: false, text: ' bound and ' },
      { math: true, tex: 'x^2' },
      { math: false, text: '.' },
    ]);
  });

  it('keeps escaped and unmatched dollars as text', () => {
    expect(splitMath('Costs \\$5 and $ more')).toEqual([{ math: false, text: 'Costs $5 and $ more' }]);
    expect(splitMath('$$')).toEqual([{ math: false, text: '$$' }]);
  });

  it('does not close on an escaped dollar inside math', () => {
    expect(splitMath('$a\\$b$')).toEqual([{ math: true, tex: 'a\\$b' }]);
  });

  it('leaves plain text alone', () => {
    expect(splitMath('No maths here')).toEqual([{ math: false, text: 'No maths here' }]);
    expect(splitMath('')).toEqual([]);
  });
});
