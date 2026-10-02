import { describe, expect, it } from 'vitest';
import { parseTex } from '@/lib/math-text';

describe('parseTex', () => {
  it('splits inline and display math, both inline', () => {
    expect(parseTex('An $O(\\sqrt{n})$ bound and $$x^2$$.')).toEqual([
      'An ',
      { math: 'O(\\sqrt{n})' },
      ' bound and ',
      { math: 'x^2' },
      '.',
    ]);
  });

  it('keeps escaped and unmatched dollars as text', () => {
    expect(parseTex('Costs \\$5 and $ more')).toEqual(['Costs $5 and $ more']);
    expect(parseTex('$$')).toEqual(['$$']);
  });

  it('does not close on an escaped dollar inside math', () => {
    expect(parseTex('$a\\$b$')).toEqual([{ math: 'a\\$b' }]);
  });

  it('leaves plain text alone', () => {
    expect(parseTex('No maths here, 7.4% better')).toEqual(['No maths here, 7.4% better']);
    expect(parseTex('')).toEqual([]);
  });

  it('styles text-mode commands, nested and with math inside', () => {
    expect(parseTex('\\textbf{P}rompt (\\textit{PRISM}) by \\textbf{7.4\\%}')).toEqual([
      { style: 'bold', children: ['P'] },
      'rompt (',
      { style: 'italic', children: ['PRISM'] },
      ') by ',
      { style: 'bold', children: ['7.4%'] },
    ]);
    expect(parseTex('\\emph{a \\textbf{b} $x$}')).toEqual([
      { style: 'italic', children: ['a ', { style: 'bold', children: ['b'] }, ' ', { math: 'x' }] },
    ]);
  });

  it('keeps the argument of an unknown command and strips bare groups', () => {
    expect(parseTex('\\citet{x} and {BERT}')).toEqual(['x', ' and ', 'BERT']);
  });

  it('sets TeX typography', () => {
    expect(parseTex("``a''~b -- c --- d\\ldots e")).toEqual(['“a” b – c — d…e']);
  });

  it('leaves unknown and unbalanced markup as written', () => {
    expect(parseTex('\\foo bar')).toEqual(['\\foo bar']);
    expect(parseTex('\\textbf{open')).toEqual(['\\textbf{open']);
    expect(parseTex('a { b')).toEqual(['a { b']);
  });
});
