import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import type { z } from 'zod';
import { ui } from '@/components/ui';
import { getPortfolio } from '@/server/accounts';
import { ApiError } from '@/server/api/errors';
import { presentComments, presentMarket, presentPortfolio, presentTapeEntry } from '@/server/api/present';
import type * as S from '@/server/api/schemas';
import { viewerFromHeaders } from '@/server/auth';
import { listComments } from '@/server/comments';
import * as events from '@/server/events';
import { marketTape, marketView, priceHistory, resolveMarket } from '@/server/views';
import { MarketLive, type Initial } from './MarketLive';

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

  const viewer = await viewerFromHeaders(await headers());
  const [view, history, tape, comments, portfolio] = await Promise.all([
    marketView(market),
    priceHistory(market, { limit: 10_000 }),
    marketTape(market, { limit: 20 }),
    listComments(market.id, { limit: 50, viewerAccountId: viewer?.account.id ?? null }),
    viewer ? getPortfolio(viewer.account.id) : null,
  ]);
  events.log('market.read', { accountId: viewer?.account.id ?? null, marketId: market.id });

  // The same JSON shapes the API serves, so the client can take over polling
  // with the initial data as its fallback.
  const initial: Initial = {
    market: presentMarket(view) as z.output<typeof S.Market>,
    history: history.points.map((p) => ({ at: p.at.toISOString(), prices: p.prices })),
    tape: { orders: tape.rows.map(presentTapeEntry), nextCursor: tape.nextCursor } as z.output<typeof S.Tape>,
    comments: presentComments(comments) as z.output<typeof S.CommentList>,
    portfolio: portfolio ? (presentPortfolio(portfolio) as z.output<typeof S.Portfolio>) : null,
    viewer: viewer
      ? { signedIn: true, canTrade: viewer.account.isBot || viewer.account.verifiedAt !== null }
      : { signedIn: false, canTrade: false },
  };

  return (
    <main className={ui.page}>
      <MarketLive initial={initial} />
    </main>
  );
}
