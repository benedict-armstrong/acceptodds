import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import type { z } from 'zod';
import { marketHref } from '@/lib/links';
import { LINK_USED } from '@/lib/link-errors';
import { parseChosenBet } from '@/lib/onboarding';
import { authHref } from '@/lib/return-to';
import { safeReturnTo } from '@/lib/return-to';
import { defaultMarketKind } from '@/lib/venue';
import { startingBalanceMicro } from '@/server/accounts';
import { presentListing, presentMarket } from '@/server/api/present';
import type * as S from '@/server/api/schemas';
import { viewerFromHeaders } from '@/server/auth';
import { hasPassword } from '@/server/better-auth';
import { choseHere, ONBOARDING_BROWSER_COOKIE, pendingBetFor } from '@/server/onboarding';
import { browseListings, listingViews, marketView, resolveListing, resolveMarket } from '@/server/views';
import { Finish } from './Finish';
import { Welcome, type Chosen, type Step } from './Welcome';

export const dynamic = 'force-dynamic';

type Listing = z.output<typeof S.Listing>;
type Market = z.output<typeof S.Market>;

/** Papers offered before anything is typed into the search. */
const SUGGESTIONS = 5;

/**
 * Onboarding: one question at a time, from "which paper?" to a placed bet
 * (`Welcome`). A visitor without an account ends by giving an email; a
 * signed-in one trades for real at each step. Back from the confirmation
 * mail, signed in with a pending bet (`server/onboarding.ts`), the last step
 * is `Finish`: a password and the bet.
 */
export default async function WelcomePage({
  searchParams,
}: {
  searchParams: Promise<{
    step?: string;
    next?: string;
    error?: string;
    market?: string;
    outcome?: string;
    stake?: string;
    seen?: string;
  }>;
}) {
  const params = await searchParams;
  // The confirmation mail's link returns here. A dead one (`?error=`), or one
  // opened again (no session: Better Auth confirms once, then only
  // redirects), goes to sign-in to say so, never back to the start.
  if (params.error) redirect(authHref('/signin', '/', { error: params.error }));
  const viewer = await viewerFromHeaders(await headers());
  if (!viewer && params.step === 'finish') redirect(authHref('/signin', '/', { error: LINK_USED }));
  const userId = viewer?.account.userId ?? null;

  if (userId) {
    const [bet, needsPassword] = await Promise.all([pendingBetFor(userId), hasPassword(userId)]);
    if (bet) {
      const market = await resolveMarket(bet.marketId);
      const listing = market.listingId ? await resolveListing(market.listingId) : null;
      const board = presentMarket(await marketView(market)) as z.output<typeof S.Market>;
      return (
        <Finish
          bet={{
            market: board,
            outcomeId: bet.outcomeId,
            stakeMicro: bet.stakeMicro.toString(),
            seenOrderCount: bet.seenOrderCount,
            choseHere: choseHere(bet, (await cookies()).get(ONBOARDING_BROWSER_COOKIE)?.value),
            title: listing?.title ?? market.question,
            href: marketHref({ marketSlug: market.slug, listingSlug: listing?.slug ?? null }),
          }}
          needsPassword={needsPassword}
        />
      );
    }
    if (needsPassword) return <Finish bet={null} needsPassword />;
    if (params.step === 'finish') redirect('/');
  }

  // A visitor who chose a bet on a market's page starts after it.
  const chosen = viewer ? null : await chosenBet(params);
  const kind = defaultMarketKind();
  const { rows } = await browseListings({ kind, status: 'open', sort: 'volume', limit: SUGGESTIONS });
  const listed = rows.flatMap((r) => (r.listing ? [r.listing] : []));
  const suggestions = (await listingViews(listed)).map(presentListing) as Listing[];

  return (
    <Welcome
      kind={kind}
      next={safeReturnTo(params.next)}
      suggestions={suggestions}
      chosen={chosen}
      initialStep={(params.step ?? null) as Step | null}
      viewer={
        viewer
          ? {
              signedIn: true,
              canTrade: viewer.account.isBot || viewer.account.verifiedAt !== null,
              cashMicro: viewer.account.balanceMicro.toString(),
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
