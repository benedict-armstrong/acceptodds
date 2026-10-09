import type { Metadata } from 'next';
import Link from 'next/link';
import { headers } from 'next/headers';
import { Amount } from '@/components/Amount';
import { DetailsTable, type DetailsRow } from '@/components/DetailsTable';
import { MathText } from '@/components/MathText';
import { OutcomeSwatch } from '@/components/OutcomeBar';
import { MakePrivateButton } from '@/components/SharePosition';
import { RememberVenue } from '@/components/RememberVenue';
import { TitleBlock } from '@/components/TitleBlock';
import { ui } from '@/components/ui';
import { day, pct, REP, shares } from '@/lib/format';
import { marketHref, publicPositionPath } from '@/lib/links';
import { viewerFromHeaders } from '@/server/auth';
import { currentVenue } from '@/server/current-venue';
import * as events from '@/server/events';
import { positionLine, siteName } from '@/server/share';
import { loadPublicPosition } from './load';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const p = await loadPublicPosition((await params).id);
  const title = `${positionLine(p)}, ${(p.market.listingTitle ?? p.market.question).replace(/\$/g, '')}`;
  const description =
    'A position its holder made public, kept up to date as they trade. See the odds, and trade on them.';
  return {
    title: `${title} | ${siteName()}`,
    description,
    alternates: { canonical: publicPositionPath(p.id) },
    openGraph: { title, description, url: publicPositionPath(p.id), type: 'article', siteName: siteName() },
    twitter: { card: 'summary_large_image', title, description },
  };
}

const STATE = {
  held: 'held',
  sold: 'sold',
  won: 'held into settlement: won',
  lost: 'held into settlement: lost',
  void: 'the market was voided',
} as const;

/**
 * A public position (#36): one trader's position in one outcome, which they
 * chose to share. Read live, so the link follows it as it is sold or settled;
 * valued by the exit quote while trading and by the payout once settled,
 * never the mark (§1.1). The only place a trader is named beside a position.
 */
export default async function PublicPositionPage({ params }: { params: Promise<{ id: string }> }) {
  const p = await loadPublicPosition((await params).id);
  const viewer = await viewerFromHeaders(await headers());
  events.log('position.read', { accountId: viewer?.account.id ?? null, marketId: p.market.id });
  const isOwner = viewer?.account.handle === p.trader.handle;
  const person = `/people/${encodeURIComponent(p.trader.handle)}`;
  const market = {
    marketSlug: p.market.slug,
    listingSlug: p.market.listingSlug,
  };
  const trading = p.market.status === 'open' || p.market.status === 'closed';
  const average =
    p.heldMicro > 0n ? Number(p.costBasisMicro) / Number(p.heldMicro) : Number(p.paidMicro) / Number(p.boughtMicro);

  const rows: DetailsRow[] = [
    [
      'Outcome',
      <span key="o" className="whitespace-nowrap">
        <OutcomeSwatch ordinal={p.outcome.ordinal} outcomes={p.outcome.count} />
        {p.outcome.label}
      </span>,
    ],
    ['Status', STATE[p.state]],
    ['Made public', `${day(p.createdAt)}, holding ${shares(p.sharedSharesMicro)} shares`],
    [p.market.status === 'settled' ? 'Shares at settlement' : 'Shares held now', shares(p.heldMicro)],
    [
      'Bought @',
      <span key="b" className={ui.mono}>
        {pct(average, true)}
      </span>,
      'a',
    ],
    ['Paid', <Amount key="p" micro={p.paidMicro} />],
  ];
  if (p.soldMicro > 0n) rows.push(['Sold for', <Amount key="s" micro={p.soldMicro} />]);
  if (p.quotedExitMicro !== null)
    rows.push(['Selling now would pay', <Amount key="x" micro={p.quotedExitMicro} />, 'b']);
  if (p.market.status === 'settled') rows.push(['Settlement paid', <Amount key="y" micro={p.payoutMicro} />]);
  rows.push(['P&L', <Amount key="l" micro={p.pnlMicro} signed />, 'c']);
  if (trading)
    rows.push([
      `${p.outcome.label} trades at`,
      <span key="n" className={ui.mono}>
        {pct(p.price, true)}
      </span>,
    ]);

  return (
    <main className={`${ui.page} max-w-[560px]`}>
      {/* The position's venue becomes the navbar's. */}
      <RememberVenue kind={p.market.kind} stale={p.market.kind !== (await currentVenue())} />
      <TitleBlock
        above={p.market.kind}
        title={<MathText text={p.market.listingTitle ?? p.market.question} />}
        byline={
          <>
            A position of <Link href={person}>{p.trader.displayName}</Link>, @{p.trader.handle}
            {p.trader.isBot && <span className={ui.badge}>bot</span>}
          </>
        }
      >
        {p.market.listingTitle && <div className="mt-1 text-[13px] text-muted">{p.market.question}</div>}
      </TitleBlock>

      <DetailsTable
        n={1}
        caption={<>{positionLine(p)}, now.</>}
        rows={rows}
        notes={[
          ['a', 'The average price paid per share held; once sold out, over every buy.'],
          [
            'b',
            'What selling every share held would pay now. Selling moves the price against the seller, so it is less than shares × price.',
          ],
          [
            'c',
            <>
              What the position has made in {REP}: sales{trading ? ', plus selling what is left now,' : ''}
              {p.market.status === 'settled' ? ' and the settlement payout,' : ''} minus what the buys cost.
            </>,
          ],
        ]}
      />

      <div className="mt-3 flex flex-wrap gap-x-5 font-sans text-sm">
        <Link href={marketHref(market)}>{trading ? 'trade this market →' : 'the market →'}</Link>
        <Link href={person}>@{p.trader.handle}’s public page →</Link>
      </div>
      {isOwner && (
        <div className="mt-4 font-sans text-[13px] text-muted">
          This is your position, and anyone with the link sees it. You can{' '}
          <MakePrivateButton outcomeId={p.outcome.id} handle={p.trader.handle} />.
        </div>
      )}
    </main>
  );
}
