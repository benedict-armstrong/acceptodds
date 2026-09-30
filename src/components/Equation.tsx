import katex from 'katex';

/**
 * A displayed equation, numbered at the right margin as a paper numbers
 * them: `n` by hand, in page order, like tables and figures. Its anchor is
 * `#eq-<n>`, which `EqRef` links to. The TeX is ours, never a user's.
 */
export function Equation({ tex, n }: { tex: string; n: number }) {
  return (
    <div id={`eq-${n}`} className="my-3 flex items-center gap-3">
      <div
        className="min-w-0 flex-1 overflow-x-auto overflow-y-hidden text-center"
        // KaTeX's output: it escapes the source itself.
        dangerouslySetInnerHTML={{ __html: katex.renderToString(tex, { displayMode: true, throwOnError: false, output: 'html' }) }}
      />
      <span className="shrink-0">({n})</span>
    </div>
  );
}

/** A reference to equation `n` in running text: "(1)". */
export function EqRef({ n }: { n: number }) {
  return <a href={`#eq-${n}`}>({n})</a>;
}
