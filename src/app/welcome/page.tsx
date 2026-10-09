import { cookies, headers } from 'next/headers';
import type { z } from 'zod';
import { marketHref } from '@/lib/links';
import { PAPER_SEARCH_LIMIT, parseChosenBet } from '@/lib/onboarding';
import { safeReturnTo } from '@/lib/return-to';
import { defaultMarketKind, VENUE_COOKIE } from '@/lib/venue';
import { venues } from '@/venues';
import { cashIn, startingBalanceMicro } from '@/server/wallets';
import { openMarketTemplate } from '@/server/market-templates';
import { presentListing, presentMarket } from '@/server/api/present';
import type * as S from '@/server/api/schemas';
import { viewerFromHeaders } from '@/server/auth';
import { browseListings, listingViews, marketView, resolveListing, resolveMarket, sparklines } from '@/server/views';
import { Welcome, type Chosen } from './Welcome';

export const dynamic = 'force-dynamic';

type Listing = z.output<typeof S.Listing>;
type Market = z.output<typeof S.Market>;

/**
 * Onboarding: one question at a time, from "which paper?" to a placed bet
 * (`Welcome`). A visitor without an account ends by giving an email, which
 * goes on to `/verify-email`; a signed-in one trades for real at each step.
 */
export default async function WelcomePage({
  searchParams,
}: {
  searchParams: Promise<{
    next?: string;
    market?: string;
    outcome?: string;
    stake?: string;
    seen?: string;
    kind?: string;
  }>;
}) {
  const params = await searchParams;
  const viewer = await viewerFromHeaders(await headers());

  // A visitor who chose a bet on a market's page starts after it.
  const chosen = viewer ? null : await chosenBet(params);
  // The venues a paper may still be picked from (their template is open), and the one searched: `?kind=`, else
  // the one this browser picked last (`VENUE_COOKIE`), else the default.
  const choosable = venues()
    .map((v) => v.kind)
    .filter((k) => openMarketTemplate(k) !== null);
  const remembered = (await cookies()).get(VENUE_COOKIE)?.value;
  const kind =
    [params.kind, remembered && decodeURIComponent(remembered)].find(
      (k): k is string => !!k && choosable.includes(k),
    ) ?? defaultMarketKind();
  const { rows } = await browseListings({
    kind,
    status: 'open',
    sort: 'volume',
    traded: true,
    limit: PAPER_SEARCH_LIMIT,
  });
  const listed = rows.flatMap((r) => (r.listing ? [r.listing] : []));
  const suggestions = (await listingViews(listed)).map(presentListing) as Listing[];
  const sparks = Object.fromEntries(await sparklines(rows.flatMap((r) => (r.main ? [r.main] : []))));

  return (
    <Welcome
      kind={kind}
      venues={choosable}
      next={safeReturnTo(params.next)}
      suggestions={suggestions}
      sparks={sparks}
      // A paper with no market opens one at JEV's price when picked: while its kind's template is open,
      // for a visitor or a viewer who may trade (the call's own gate).
      canOpen={
        openMarketTemplate(kind) !== null && (!viewer || viewer.account.isBot || viewer.account.verifiedAt !== null)
      }
      chosen={chosen}
      viewer={
        viewer
          ? {
              signedIn: true,
              canTrade: viewer.account.isBot || viewer.account.verifiedAt !== null,
              cashMicro: (await cashIn(viewer.account.id, kind)).toString(),
            }
          : { signedIn: false, canTrade: false, cashMicro: startingBalanceMicro().toString() }
      }
    />
  );
}

/**
 * The bet in the URL (`welcomeBetHref`), if it is still one a visitor can
 * make: an open market before its close, one of its outcomes, and a stake
 * within the starting balance — what `POST /onboarding` will check again.
 */
async function chosenBet(params: {
  market?: string;
  outcome?: string;
  stake?: string;
  seen?: string;
}): Promise<Chosen | null> {
  const bet = parseChosenBet(params);
  if (!bet || bet.stakeMicro > startingBalanceMicro()) return null;
  const market = await resolveMarket(bet.marketId).catch(() => null);
  if (!market || market.status !== 'open' || market.closesAt.getTime() <= Date.now()) return null;
  const board = presentMarket(await marketView(market)) as Market;
  if (!board.outcomes.some((o) => o.id === bet.outcomeId)) return null;
  const listing = market.listingId ? await resolveListing(market.listingId) : null;
  return {
    pick: {
      market: board,
      title: listing?.title ?? market.question,
      href: marketHref({ marketSlug: market.slug, listingSlug: listing?.slug ?? null }),
    },
    choice: { outcomeId: bet.outcomeId, stakeMicro: bet.stakeMicro, seenOrderCount: bet.seenOrderCount },
  };
}
