/**
 * The math opening at `i`, if a `$` or `$$` there has a closing partner with
 * something between: its TeX and the index just past the closing fence.
 */
function mathAt(input: string, i: number): { tex: string; end: number } | null {
  if (input[i] !== '$') return null;
  const fence = input[i + 1] === '$' ? '$$' : '$';
  const start = i + fence.length;
  let end = start;
  // The closing fence: the next unescaped one, not immediately after the opening.
  while (end < input.length) {
    if (input[end] === '\\') end += 2;
    else if (input.startsWith(fence, end)) break;
    else end++;
  }
  const tex = input.slice(start, end);
  return end < input.length && tex.trim() ? { tex, end: end + fence.length } : null;
}

/** A run of text set in one of TeX's text-mode styles. */
export type TexStyle = 'bold' | 'italic' | 'mono' | 'smallcaps' | 'underline' | 'plain';
export type TexNode = string | { math: string } | { style: TexStyle; children: TexNode[] };

/** Commands that set their one argument in a style. Any other `\cmd{…}` keeps the argument, unstyled. */
const STYLE: Record<string, TexStyle> = {
  textbf: 'bold',
  textit: 'italic',
  textsl: 'italic',
  emph: 'italic',
  texttt: 'mono',
  textsc: 'smallcaps',
  underline: 'underline',
  textrm: 'plain',
  textsf: 'plain',
  textup: 'plain',
  textmd: 'plain',
  textnormal: 'plain',
};

/** Commands with no argument that stand for text. TeX eats the space after them. */
const SYMBOL: Record<string, string> = {
  ldots: '…',
  dots: '…',
  LaTeX: 'LaTeX',
  TeX: 'TeX',
  textendash: '–',
  textemdash: '—',
  textasciitilde: '~',
};

/** Characters `\` makes literal in text. */
const ESCAPED = new Set(['$', '%', '&', '_', '#', '{', '}']);

/**
 * Text with inline math and TeX's text-mode markup, as an abstract or title
 * from a paper carries it: `$…$` and `$$…$$` math (both inline; a `$` with
 * no closing partner stays text), `\textbf{…}`,
 * `\textit{…}`, `\emph{…}`, `\texttt{…}`, `\textsc{…}`, `\underline{…}`
 * (nested freely, math inside too), bare `{…}` groups, `\%` and the other
 * escapes, `~`, ` `` '' `, `--`, `---`, `\ldots`. An unknown `\cmd{…}` keeps
 * its argument; an unknown `\cmd` alone, and anything unbalanced, stays as
 * written, so nothing is silently dropped. A bare `%` is a percent sign, not
 * a comment: plain-text abstracts write it that way. Client-safe.
 */
export function parseTex(input: string): TexNode[] {
  const out: TexNode[] = [];
  let text = '';
  const flush = () => {
    if (text) out.push(text);
    text = '';
  };
  let i = 0;
  while (i < input.length) {
    const c = input[i];
    if (c === '\\') {
      const next = input[i + 1] ?? '';
      if (ESCAPED.has(next)) {
        text += next;
        i += 2;
        continue;
      }
      if (next === '\\' || next === ' ') {
        text += ' ';
        i += 2;
        continue;
      }
      if (next === ',') {
        text += ' ';
        i += 2;
        continue;
      }
      const name = /^[A-Za-z]+/.exec(input.slice(i + 1))?.[0];
      if (name) {
        const after = i + 1 + name.length;
        if (input[after] === '{') {
          const close = closingBrace(input, after);
          if (close !== -1) {
            flush();
            const children = parseTex(input.slice(after + 1, close));
            const style = STYLE[name];
            if (style) out.push({ style, children });
            else out.push(...children);
            i = close + 1;
            continue;
          }
        } else if (name in SYMBOL) {
          text += SYMBOL[name];
          i = input[after] === ' ' ? after + 1 : after;
          continue;
        }
      }
      text += c;
      i++;
      continue;
    }
    const math = mathAt(input, i);
    if (math) {
      flush();
      out.push({ math: math.tex });
      i = math.end;
      continue;
    }
    if (c === '{') {
      const close = closingBrace(input, i);
      if (close !== -1) {
        flush();
        out.push(...parseTex(input.slice(i + 1, close)));
        i = close + 1;
        continue;
      }
    }
    const typo = TYPOGRAPHY.find(([from]) => input.startsWith(from, i));
    if (typo) {
      text += typo[1];
      i += typo[0].length;
      continue;
    }
    text += c;
    i++;
  }
  flush();
  return out;
}

/** TeX's ligatures and active characters in text, longest first. */
const TYPOGRAPHY: [string, string][] = [
  ['---', '—'],
  ['--', '–'],
  ['``', '“'],
  ["''", '”'],
  ['~', ' '],
];

/** The index of the `}` matching the `{` at `open`, skipping escaped braces; -1 when unbalanced. */
function closingBrace(input: string, open: number): number {
  let depth = 0;
  for (let i = open; i < input.length; i++) {
    if (input[i] === '\\') i++;
    else if (input[i] === '{') depth++;
    else if (input[i] === '}' && --depth === 0) return i;
  }
  return -1;
}

/**
 * Hard-wrapped text unwrapped: a single line break (a sentence per line, or
 * a source wrapped at 80 columns) is a space, as TeX and HTML read it; a
 * blank line stays a paragraph break. Carriage returns are dropped.
 */
export function unwrapLines(input: string): string {
  return input
    .replace(/\r\n?/g, '\n')
    .split(/\n[ \t]*\n+/)
    .map((para) => para.replace(/\s*\n\s*/g, ' ').trim())
    .filter(Boolean)
    .join('\n\n');
}
