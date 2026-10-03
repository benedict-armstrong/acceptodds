import type { Metadata } from 'next';
import Link from 'next/link';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { Citations } from '@/components/Citations';
import { FollowStar } from '@/components/FollowStar';
import { MathText } from '@/components/MathText';
import { TableNotes } from '@/components/TableNotes';
import { RunningHead } from '@/components/RunningHead';
import { TitleBlock } from '@/components/TitleBlock';
import { ViewCount } from '@/components/ViewCount';
import { ui } from '@/components/ui';
import { pct } from '@/lib/format';
import { marketHeadline, shareTitleLine } from '@/lib/headline';
import { shortPath } from '@/lib/links';
import { likelihoodClass, marketLikelihood } from '@/lib/likelihood';
import type { z } from 'zod';
import { ApiError } from '@/server/api/errors';
import { presentMarket } from '@/server/api/present';
import type * as S from '@/server/api/schemas';
import { viewerFromHeaders } from '@/server/auth';
import * as events from '@/server/events';
import { followedListingIds } from '@/server/follows';
import { shareSubject, siteName, siteUrl } from '@/server/share';
import { listingCitations, listingView, resolveListing, type MarketView } from '@/server/views';
import { loadMarketLive } from '../../markets/[slug]/load';
import { MarketLive } from '../../markets/[slug]/MarketLive';
import { SharePanel } from './SharePanel';

export const dynamic = 'force-dynamic';

/**
 * The link preview's text (issue #11 §1): the title as a question and no
 * numbers — the image shows which way it leans, the page how far. The image
 * is `opengraph-image.tsx`, which Next adds by itself.
 */
export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const subject = await shareSubject(decodeURIComponent((await params).slug));
  if (!subject) return {};
  const question = shareTitleLine(subject.title, subject.kind, 120);
  const description = subject.kind
    ? `Where do traders think this paper lands at ${subject.kind}? See the odds, and trade on them.`
    : 'See the odds, and trade on them.';
  return {
    title: `${subject.title.replace(/\$/g, '')} | ${siteName()}`,
    description,
    alternates: { canonical: subject.path },
    openGraph: { title: question, description, url: subject.path, type: 'article', siteName: siteName() },
    twitter: { card: 'summary_large_image', title: question, description },
  };
}

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
  const [{ markets, followers }, citations] = await Promise.all([listingView(listing), listingCitations(listing)]);
  const wanted = Array.isArray(sp.market) ? sp.market[0] : sp.market;
  const selected = markets.find((m) => m.market.slug === wanted) ?? markets[0];

  const viewer = await viewerFromHeaders(await headers());
  const initial = selected ? await loadMarketLive(selected.market, viewer) : null;
  const following = viewer ? (await followedListingIds(viewer.account.id)).has(listing.id) : false;
  events.log('listing.read', { accountId: viewer?.account.id ?? null });

  return (
    <main className={ui.page}>
      {listing.kind && <RunningHead>Under review as a conference paper at {listing.kind}</RunningHead>}
      <TitleBlock
        title={<MathText text={listing.title} />}
        byline={listing.authors.length > 0 ? listing.authors.join(', ') : null}
        abstract={listing.summary}
        abstractMath
      >
        {listing.links.length > 0 && (
          <div className="mt-1.5 flex flex-wrap justify-center gap-x-3 font-sans text-[13px]">
            {listing.links.map((l) => (
              <a key={l.url} href={l.url} className="text-accent" rel="noopener noreferrer" target="_blank">
                [{l.label}]
              </a>
            ))}
          </div>
        )}
        <div className="mt-2 flex items-center justify-center gap-4">
          <ViewCount listingId={listing.id} views={listing.viewCount} />
          <FollowStar
            listingId={listing.id}
            following={following}
            followers={followers}
            showCount
            signUpNext={viewer ? undefined : `/papers/${listing.slug}`}
            className="text-[15px]"
          />
          {markets[0] && (
            <SharePanel
              title={listing.title}
              kind={listing.kind ?? markets[0].market.kind}
              shareUrl={`${siteUrl()}${shortPath(listing.shortId)}`}
              badgeUrl={`${siteUrl()}/badge/${encodeURIComponent(listing.slug)}.svg`}
              initial={presentMarket(markets[0]) as z.output<typeof S.Market>}
            />
          )}
        </div>
      </TitleBlock>

      {/* One market per paper is the default; the list is only for a paper with more. */}
      {markets.length === 0 && <div className={ui.empty}>No markets on this paper yet.</div>}
      {markets.length > 1 && (
        <section className="mt-10">
          <h2 className={`${ui.section} mb-3`}>Markets</h2>
          <table className={ui.table}>
            <caption className={ui.tableCaption}>
              <b>Table 1.</b> The markets on this paper, main market first. The one shown below is highlighted.
            </caption>
            <thead>
              <tr>
                <th className={ui.th()}>Market</th>
                <th className={ui.th(true)}>
                  Chance<sup className={ui.mark}>a</sup>
                </th>
              </tr>
            </thead>
            <tbody>
              {markets.map((m) => {
                const on = m.market.id === selected?.market.id;
                const look = likelihoodClass(marketLikelihood({ ...m.market, outcomes: m.outcomes }));
                return (
                  <tr key={m.market.id} className={on ? 'bg-tint' : ''}>
                    <td className={ui.td}>
                      <Link
                        href={`/papers/${encodeURIComponent(listing.slug)}?market=${encodeURIComponent(m.market.slug)}`}
                        scroll={false}
                        aria-current={on ? 'page' : undefined}
                        className={on ? 'font-semibold text-ink' : 'text-ink'}
                      >
                        {m.market.question}
                      </Link>
                      {m.market.status !== 'open' && <span className={ui.badge}>{m.market.status}</span>}
                    </td>
                    <td className={`${ui.td} ${ui.num}`}>
                      <span className={`rounded-[3px] px-1.5 ${look.chip}`}>{headline(m)}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <TableNotes
            notes={[
              [
                'a',
                'One minus the price of the last outcome: for a decision, the chance the paper is accepted in any form; for a yes/no question, the chance of yes. Once settled, the result.',
              ],
            ]}
          />
        </section>
      )}

      {initial && (
        <MarketLive key={initial.market.id} initial={initial} embedded firstTable={markets.length > 1 ? 2 : 1} />
      )}

      <Citations citations={citations} />

      <footer className="mt-12 border-t border-rule pt-3 text-center font-sans text-[13px] text-muted">
        <a
          href={reportHref(listing.title, `${siteUrl()}/papers/${encodeURIComponent(listing.slug)}`)}
          className="text-muted underline"
        >
          Report a problem with this page
        </a>
      </footer>
    </main>
  );
}

/** Where problem reports go. */
const REPORT_EMAIL = 'office@acceptodds.com';

/** A mailto: link: "[Issue] <title, cut>" as the subject, the paper's link in the body. */
function reportHref(title: string, url: string): string {
  const short = title.length > 60 ? `${title.slice(0, 59).trimEnd()}…` : title;
  const body = `${title}\n${url}\n\nWhat's the problem?\n`;
  return `mailto:${REPORT_EMAIL}?subject=${encodeURIComponent(`[Issue] ${short}`)}&body=${encodeURIComponent(body)}`;
}

/** The headline (`lib/headline.ts`). Settled: the winner. Void: a dash. */
function headline(v: MarketView): string {
  if (v.market.status === 'settled') {
    return v.outcomes.find((o) => o.id === v.market.resolvedOutcomeId)?.label ?? 'settled';
  }
  const h = marketHeadline({ ...v.market, outcomes: v.outcomes });
  return h === null ? '—' : pct(h);
}
