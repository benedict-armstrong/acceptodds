import type { z } from 'zod';
import type { Account, Market } from '@/db/schema';
import { getPortfolio } from '@/server/accounts';
import { presentComments, presentMarket, presentPortfolio, presentTapeEntry } from '@/server/api/present';
import type * as S from '@/server/api/schemas';
import { listComments } from '@/server/comments';
import * as events from '@/server/events';
import { marketTape, marketView, priceHistory } from '@/server/views';
import type { Initial } from './MarketLive';

/**
 * Everything `MarketLive` starts from, for one market, read on the server.
 * Shared by the market page and the listing ("paper") page, which renders
 * its selected market the same way.
 *
 * These are the same JSON shapes the API serves, so the client can take over
 * polling with the initial data as its fallback.
 */
export async function loadMarketLive(market: Market, viewer: { account: Account } | null): Promise<Initial> {
  const [view, history, tape, comments, portfolio] = await Promise.all([
    marketView(market),
    priceHistory(market, { limit: 10_000 }),
    marketTape(market, { limit: 20 }),
    listComments(market.id, { limit: 50, viewerAccountId: viewer?.account.id ?? null }),
    viewer ? getPortfolio(viewer.account.id) : null,
  ]);
  events.log('market.read', { accountId: viewer?.account.id ?? null, marketId: market.id });

  return {
    market: presentMarket(view) as z.output<typeof S.Market>,
    history: history.points.map((p) => ({ at: p.at.toISOString(), prices: p.prices })),
    tape: { orders: tape.rows.map(presentTapeEntry), nextCursor: tape.nextCursor } as z.output<typeof S.Tape>,
    comments: presentComments(comments) as z.output<typeof S.CommentList>,
    portfolio: portfolio ? (presentPortfolio(portfolio) as z.output<typeof S.Portfolio>) : null,
    viewer: viewer
      ? { signedIn: true, canTrade: viewer.account.isBot || viewer.account.verifiedAt !== null }
      : { signedIn: false, canTrade: false },
  };
}
