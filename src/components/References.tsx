import type { ReactNode } from 'react';
import { ui } from './ui';

/** A citation in running text, "[1]" or "[1, 2]", linking to its entry in `References`. */
export function Cite({ n }: { n: number | number[] }) {
  const ns = Array.isArray(n) ? n : [n];
  return (
    <>
      [
      {ns.map((k, i) => (
        <span key={k}>
          {i > 0 && ', '}
          <a href={`#ref-${k}`}>{k}</a>
        </span>
      ))}
      ]
    </>
  );
}

/**
 * A page's bibliography, under an unnumbered "References" heading as a
 * paper's back matter is. Entries are numbered in the order given, which is
 * the order `Cite` numbers them in: `#ref-1`, `#ref-2`, ….
 */
export function References({ items }: { items: ReactNode[] }) {
  return (
    <section>
      <h2 className={ui.backHeading}>References</h2>
      <ol className="space-y-1.5 text-sm leading-snug">
        {items.map((item, i) => (
          <li key={i} id={`ref-${i + 1}`} className="grid grid-cols-[2.2em_1fr]">
            <span>[{i + 1}]</span>
            <span>{item}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
