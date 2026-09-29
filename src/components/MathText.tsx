import katex from 'katex';
import { splitMath } from '@/lib/math-text';

/**
 * A line of text with inline TeX (`$…$`), for titles. Plain segments are
 * React text; math is KaTeX's own escaped HTML, with `trust: false` (its
 * default) so `\href` and friends are inert, and invalid TeX shown as source
 * rather than thrown. KaTeX's stylesheet is imported in `app/layout.tsx`.
 */
export function MathText({ text }: { text: string }) {
  return (
    <>
      {splitMath(text).map((s, i) =>
        s.math ? (
          <span
            key={i}
            // KaTeX's output: it escapes the source itself.
            dangerouslySetInnerHTML={{ __html: katex.renderToString(s.tex, { throwOnError: false, output: 'html' }) }}
          />
        ) : (
          s.text
        ),
      )}
    </>
  );
}
