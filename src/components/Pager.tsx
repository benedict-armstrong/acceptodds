import Link from 'next/link';
import type { ReactNode } from 'react';
import { ui } from './ui';

/**
 * Page links: prev, the first and last pages, a window around the current
 * one, next. Plain links, so paging works without JavaScript. Nothing for a
 * single page. `page` 0 means no page is current (a list shown some other
 * way, which the pager leads into): only the page numbers are shown, even
 * for a single page. Set like a paper's folio: centred under the list, in
 * the serif, the current page an en-dash-flanked number held at the centre
 * whatever is either side of it.
 */
export function Pager({
  page,
  pages,
  href,
  label,
}: {
  page: number;
  pages: number;
  href: (p: number) => string;
  /** Before the links, for a pager that is not obviously one. */
  label?: ReactNode;
}) {
  if (pages <= 1 && page !== 0) return null;
  const shown = [...new Set([1, page - 2, page - 1, page, page + 1, page + 2, pages])]
    .filter((p) => p >= 1 && p <= pages)
    .sort((a, b) => a - b);
  // Each page link, with an ellipsis before it after a gap.
  const links = (ps: number[]) =>
    ps.map((p) => {
      const prev = shown[shown.indexOf(p) - 1];
      return (
        <span key={p} className="flex gap-3">
          {prev !== undefined && p > prev + 1 && <span aria-hidden>…</span>}
          <Link href={href(p)}>{p}</Link>
        </span>
      );
    });
  const row = 'flex flex-wrap items-baseline gap-x-3 gap-y-1 narrow:gap-x-4 narrow:gap-y-2';
  const look = 'mt-6 font-serif text-sm text-muted tabular-nums';

  if (page === 0) {
    return (
      <nav aria-label="Pages" className={`${look} ${row} justify-center`}>
        {label && <span>{label}</span>}
        {links(shown)}
      </nav>
    );
  }

  // Three columns, the outer two equal, so the current page sits at the centre.
  const side = (justify: string, children: ReactNode) => <div className={`${row} ${justify}`}>{children}</div>;
  return (
    <nav aria-label="Pages" className={`${look} grid grid-cols-[1fr_auto_1fr] items-baseline gap-x-3 narrow:gap-x-4`}>
      {side(
        'justify-end',
        <>
          {label && <span>{label}</span>}
          {page > 1 && (
            <Link href={href(page - 1)} rel="prev">
              ← prev
            </Link>
          )}
          {links(shown.filter((p) => p < page))}
        </>,
      )}
      <span aria-current="page" className={ui.on}>
        – {page} –
      </span>
      {side(
        'justify-start',
        <>
          {links(shown.filter((p) => p > page))}
          {page < pages && (
            <Link href={href(page + 1)} rel="next">
              next →
            </Link>
          )}
        </>,
      )}
    </nav>
  );
}
