/**
 * Split one line of text into plain and TeX segments, for titles: `$…$` and
 * `$$…$$` are math (both inline, since a title is one line), `\$` is a
 * literal dollar, and a `$` with no closing partner stays text. Client-safe.
 */
export type Segment = { math: false; text: string } | { math: true; tex: string };

export function splitMath(input: string): Segment[] {
  const out: Segment[] = [];
  let text = '';
  let i = 0;
  const flush = () => {
    if (text) out.push({ math: false, text });
    text = '';
  };
  while (i < input.length) {
    if (input[i] === '\\' && input[i + 1] === '$') {
      text += '$';
      i += 2;
      continue;
    }
    if (input[i] === '$') {
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
      if (end < input.length && tex.trim()) {
        flush();
        out.push({ math: true, tex });
        i = end + fence.length;
        continue;
      }
    }
    text += input[i];
    i++;
  }
  flush();
  return out;
}
