import katex from 'katex';
import { parseTex, type TexNode, type TexStyle } from '@/lib/math-text';

const STYLE_CLASS: Record<TexStyle, string> = {
  bold: 'font-bold',
  italic: 'italic',
  mono: 'font-mono',
  smallcaps: '[font-variant:small-caps]',
  underline: 'underline',
  plain: 'not-italic font-normal',
};

/**
 * Text with inline TeX, for titles and abstracts: `$…$` math and text-mode
 * markup such as `\textbf{…}` (`parseTex`). Text is React text; math is
 * KaTeX's own escaped HTML, with `trust: false` (its default) so `\href` and
 * friends are inert, and invalid TeX shown as source rather than thrown.
 * KaTeX's stylesheet is imported in `app/layout.tsx`.
 */
export function MathText({ text }: { text: string }) {
  return <Nodes nodes={parseTex(text)} />;
}

function Nodes({ nodes }: { nodes: TexNode[] }) {
  return (
    <>
      {nodes.map((n, i) =>
        typeof n === 'string' ? (
          n
        ) : 'math' in n ? (
          <span
            key={i}
            // KaTeX's output: it escapes the source itself.
            dangerouslySetInnerHTML={{ __html: katex.renderToString(n.math, { throwOnError: false, output: 'html' }) }}
          />
        ) : (
          <span key={i} className={STYLE_CLASS[n.style]}>
            <Nodes nodes={n.children} />
          </span>
        ),
      )}
    </>
  );
}
