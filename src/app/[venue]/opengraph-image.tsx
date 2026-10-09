import { notFound } from 'next/navigation';
import { homeImage, OG_SIZE } from '@/server/og';
import { venueBySlug } from '@/venues';

export const alt = 'acceptodds: a prediction market on research papers';
export const size = OG_SIZE;
export const contentType = 'image/png';
export const dynamic = 'force-dynamic';

/**
 * A venue's link preview: its home card at its prior. The home page and the
 * map name it for their venue (`venueImagePath`), and the root layout for
 * the default venue, so every page without its own preview has one.
 */
export default async function Image({ params }: { params: Promise<{ venue: string }> }) {
  const v = venueBySlug(decodeURIComponent((await params).venue));
  if (!v) notFound();
  return homeImage(v);
}
