import { notFound, redirect } from 'next/navigation';
import { venueBySlug } from '@/venues';

/**
 * `/<venue>` (`/ICLR2027`, `/OpenAIMath`, any case): a short link to a
 * venue's home page. It goes to `/?kind=`, which makes that venue the
 * navbar's (`RememberVenue`) and gives a crawler that venue's preview,
 * since a crawler keeps no cookie. Any other single segment is a 404.
 */
export default async function VenueShortcut({ params }: { params: Promise<{ venue: string }> }) {
  const v = venueBySlug(decodeURIComponent((await params).venue));
  if (!v) notFound();
  redirect(`/?${new URLSearchParams({ kind: v.kind })}`);
}
