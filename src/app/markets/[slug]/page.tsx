import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { ui } from '@/components/ui';
import { ApiError } from '@/server/api/errors';
import { viewerFromHeaders } from '@/server/auth';
import { shareSubject, siteName } from '@/server/share';
import { resolveListing, resolveMarket } from '@/server/views';
import { loadMarketLive } from './load';
import { MarketLive } from './MarketLive';

export const dynamic = 'force-dynamic';

/** The link preview's text for a market with no listing (a listed one redirects to its paper). */
export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const subject = await shareSubject(decodeURIComponent((await params).slug));
  if (!subject || subject.listing) return {};
  const description = 'See the odds, and trade on them.';
  return {
    title: `${subject.title} · papermarket`,
    description,
    alternates: { canonical: subject.path },
    openGraph: { title: subject.title, description, url: subject.path, siteName: siteName() },
    twitter: { card: 'summary_large_image', title: subject.title, description },
  };
}

export default async function MarketPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  let market;
  try {
    market = await resolveMarket(decodeURIComponent(slug));
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound();
    throw err;
  }
  if (market.status === 'draft') notFound();

  // A market in a listing lives on its listing's page.
  if (market.listingId) {
    const listing = await resolveListing(market.listingId);
    redirect(`/papers/${encodeURIComponent(listing.slug)}?market=${encodeURIComponent(market.slug)}`);
  }

  const viewer = await viewerFromHeaders(await headers());
  const initial = await loadMarketLive(market, viewer);

  return (
    <main className={ui.page}>
      <MarketLive initial={initial} />
    </main>
  );
}
