import Link from 'next/link';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { FollowStar } from '@/components/FollowStar';
import { MathText } from '@/components/MathText';
import { ui } from '@/components/ui';
import { pct } from '@/lib/format';
import { likelihoodClass, marketLikelihood } from '@/lib/likelihood';
import { ApiError } from '@/server/api/errors';
import { viewerFromHeaders } from '@/server/auth';
import * as events from '@/server/events';
import { followedListingIds } from '@/server/follows';
import { listingView, resolveListing, type MarketView } from '@/server/views';
import { loadMarketLive } from '../../markets/[slug]/load';
import { MarketLive } from '../../markets/[slug]/MarketLive';
import { Abstract } from './Abstract';

export const dynamic = 'force-dynamic';

/**
 * A listing's page. The platform calls it a listing and knows nothing about
 * what it is; the UI calls it a paper, because that is what `../research`
 * lists. Title, names, links and summary are shown as the client supplied
 * them. Below them, its markets, and the selected one (`?market=<slug>`,
 * default the main market, rank 0) rendered live.
 */
export default async function PaperPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug } = await params;
  const sp = await searchParams;
  let listing;
  try {
    listing = await resolveListing(decodeURIComponent(slug));
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound();
    throw err;
  }
  const { markets, followers } = await listingView(listing);
  const wanted = Array.isArray(sp.market) ? sp.market[0] : sp.market;
  const selected = markets.find((m) => m.market.slug === wanted) ?? markets[0];

  const viewer = await viewerFromHeaders(await headers());
  const initial = selected ? await loadMarketLive(selected.market, viewer) : null;
  const following = viewer ? (await followedListingIds(viewer.account.id)).has(listing.id) : false;
  events.log('listing.read', { accountId: viewer?.account.id ?? null });

  return (
    <main className={ui.page}>
      {listing.kind && <div className="mt-4.5 text-center font-mono text-[13px] text-muted">{listing.kind}</div>}
      <h1 className="mt-2 mb-1 text-center text-[30px] leading-tight font-normal">
        <MathText text={listing.title} />
      </h1>
      {listing.authors.length > 0 && (
        <div className="mx-auto max-w-[680px] text-center text-[15px] text-subtle">{listing.authors.join(', ')}</div>
      )}
      {listing.links.length > 0 && (
        <div className="mt-1.5 flex flex-wrap justify-center gap-x-3 font-sans text-[13px]">
          {listing.links.map((l) => (
            <a key={l.url} href={l.url} className="text-accent" rel="noopener noreferrer" target="_blank">
              [{l.label}]
            </a>
          ))}
        </div>
      )}
      {viewer && (
        <div className="mt-2 flex justify-center">
          <FollowStar listingId={listing.id} following={following} followers={followers} showCount className="text-[17px]" />
        </div>
      )}
      {listing.summary && <Abstract text={listing.summary} />}

      <section className="mt-6">
        <h3 className={ui.sectionHeading}>Markets</h3>
        {markets.length === 0 && <div className={ui.empty}>No markets on this paper yet.</div>}
        {markets.map((m) => {
          const on = m.market.id === selected?.market.id;
          const look = likelihoodClass(marketLikelihood({ ...m.market, outcomes: m.outcomes }));
          return (
            <Link
              key={m.market.id}
              href={`/papers/${encodeURIComponent(listing.slug)}?market=${encodeURIComponent(m.market.slug)}`}
              scroll={false}
              aria-current={on ? 'page' : undefined}
              className={`grid grid-cols-[3px_1fr_auto] items-center gap-2.5 border-b border-dotted border-rule-strong py-1.5 hover:bg-highlight hover:no-underline ${
                on ? 'bg-tint font-semibold' : ''
              }`}
            >
              <span className={`self-stretch ${look.bar}`} aria-hidden />
              <span className="leading-[1.35]">
                {m.market.question}
                {m.market.status !== 'open' && <span className={ui.badge}>{m.market.status}</span>}
              </span>
              <span className={`rounded-[3px] px-1.5 font-mono text-sm ${look.chip}`}>{headline(m)}</span>
            </Link>
          );
        })}
      </section>

      {initial && <MarketLive key={initial.market.id} initial={initial} embedded />}
    </main>
  );
}

/** Binary: the first outcome's price. More outcomes: the favourite, named. Settled: the winner. */
function headline(v: MarketView): string {
  if (v.market.status === 'settled') {
    return v.outcomes.find((o) => o.id === v.market.resolvedOutcomeId)?.label ?? 'settled';
  }
  if (v.outcomes.length === 2) return pct(v.outcomes[0].price);
  const top = [...v.outcomes].sort((a, b) => b.price - a.price)[0];
  return `${top.label} ${pct(top.price)}`;
}
