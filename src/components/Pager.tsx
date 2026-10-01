import Link from 'next/link';
import { ui } from './ui';

/**
 * Page links: prev, the first and last pages, a window around the current
 * one, next. Plain links, so paging works without JavaScript. Nothing for a
 * single page. `page` 0 means no page is current (a list shown some other
 * way, which the pager leads into): only the page numbers are shown, even
 * for a single page.
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
  label?: string;
}) {
  if (pages <= 1 && page !== 0) return null;
  const shown = [...new Set([1, page - 2, page - 1, page, page + 1, page + 2, pages])]
    .filter((p) => p >= 1 && p <= pages)
    .sort((a, b) => a - b);
  return (
    <nav
      aria-label="Pages"
      className="mt-2 flex flex-wrap justify-end gap-x-3 gap-y-1 font-sans text-[13px] text-muted narrow:gap-x-4 narrow:gap-y-2 narrow:text-sm"
    >
      {label && <span>{label}</span>}
      {page > 1 && (
        <Link href={href(page - 1)} rel="prev">
          ← prev
        </Link>
      )}
      {shown.map((p, i) => (
        <span key={p} className="flex gap-3">
          {i > 0 && p > shown[i - 1] + 1 && <span aria-hidden>…</span>}
          {p === page ? (
            <span aria-current="page" className={ui.on}>
              {p}
            </span>
          ) : (
            <Link href={href(p)}>{p}</Link>
          )}
        </span>
      ))}
      {page >= 1 && page < pages && (
        <Link href={href(page + 1)} rel="next">
          next →
        </Link>
      )}
    </nav>
  );
}
