import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import type { z } from 'zod';
import { marketHref } from '@/lib/links';
import { safeReturnTo } from '@/lib/return-to';
import { defaultMarketKind } from '@/lib/venue';
import { startingBalanceMicro } from '@/server/accounts';
import { presentListing, presentMarket } from '@/server/api/present';
import type * as S from '@/server/api/schemas';
import { viewerFromHeaders } from '@/server/auth';
import { hasPassword, pendingBetFor } from '@/server/onboarding';
import { browseListings, listingViews, marketView, resolveListing, resolveMarket } from '@/server/views';
import { Finish } from './Finish';
import { Welcome, type Step } from './Welcome';

export const dynamic = 'force-dynamic';

type Listing = z.output<typeof S.Listing>;

/** Papers offered before anything is typed into the search. */
const SUGGESTIONS = 5;

/**
 * Onboarding: one question at a time, from "which paper?" to a placed bet
 * (`Welcome`). A visitor without an account ends by giving an email; a
 * signed-in one trades for real at each step. Back from the confirmation
 * mail, signed in with a pending bet (`server/onboarding.ts`), the last step
 * is `Finish`: a password and the bet.
 */
export default async function WelcomePage({ searchParams }: { searchParams: Promise<{ step?: string; next?: string }> }) {
  const viewer = await viewerFromHeaders(await headers());
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
            comment: bet.comment,
            title: listing?.title ?? market.question,
            href: marketHref({ marketSlug: market.slug, listingSlug: listing?.slug ?? null }),
          }}
          needsPassword={needsPassword}
        />
      );
    }
    if (needsPassword) return <Finish bet={null} needsPassword />;
    if ((await searchParams).step === 'finish') redirect('/');
  }

  const kind = defaultMarketKind();
  const { rows } = await browseListings({ kind, status: 'open', sort: 'volume', limit: SUGGESTIONS });
  const listed = rows.flatMap((r) => (r.listing ? [r.listing] : []));
  const suggestions = (await listingViews(listed)).map(presentListing) as Listing[];

  return (
    <Welcome
      kind={kind}
      next={safeReturnTo((await searchParams).next)}
      suggestions={suggestions}
      initialStep={((await searchParams).step ?? null) as Step | null}
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
