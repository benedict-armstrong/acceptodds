import Link from 'next/link';
import type { ReactNode } from 'react';
import { marketHref } from '@/lib/links';
import { MathText } from './MathText';

/**
 * A position's paper in a table cell: its title (a market with no listing,
 * its question) on one line, cut with an ellipsis past ~22rem, the whole
 * title on hover, linked to the market. At least 14rem wide, so on a phone
 * the table scrolls sideways (`ui.tableScroll`) rather than squeezing it.
 * `children` follow it on the same line (a status badge).
 */
export function PaperName({
  m,
  children,
}: {
  m: { marketSlug: string; listingSlug: string | null; listingTitle: string | null; question: string };
  children?: ReactNode;
}) {
  const name = m.listingTitle ?? m.question;
  return (
    <span className="flex min-w-56 items-baseline">
      <Link href={marketHref(m)} title={name} className="max-w-88 truncate">
        <MathText text={name} />
      </Link>
      {children}
    </span>
  );
}
