import { headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { ui } from '@/components/ui';
import { ApiError } from '@/server/api/errors';
import { viewerFromHeaders } from '@/server/auth';
import { resolveListing, resolveMarket } from '@/server/views';
import { loadMarketLive } from './load';
import { MarketLive } from './MarketLive';

export const dynamic = 'force-dynamic';

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
