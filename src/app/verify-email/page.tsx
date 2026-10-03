import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { OnboardingCard } from '@/components/OnboardingCard';
import type { PendingBet as StoredPendingBet } from '@/db/schema';
import { LINK_USED } from '@/lib/link-errors';
import { marketHref } from '@/lib/links';
import { authHref, safeReturnTo } from '@/lib/return-to';
import { presentMarket } from '@/server/api/present';
import type * as S from '@/server/api/schemas';
import type { z } from 'zod';
import { viewerFromHeaders } from '@/server/auth';
import { missingFromUser } from '@/server/better-auth';
import { choseHere, ONBOARDING_BROWSER_COOKIE, pendingBetFor, pendingBetOrderKey } from '@/server/onboarding';
import { marketView, resolveListing, resolveMarket } from '@/server/views';
import { CodeForm } from './CodeForm';
import { Finish, type PendingBet } from './Finish';

export const dynamic = 'force-dynamic';

/**
 * The one page after an email: where every mail's link lands and where its
 * code is typed. Which of the three it shows follows from the session, never
 * from how the person got here.
 *
 * - **Signed in, nothing owed:** straight on to `next`.
 * - **Signed in, something owed** (a name, a password, a bet waiting to be
 *   placed): `Finish` asks for what is missing, places the bet, goes on.
 * - **No session, an address in the URL:** the code from the mail, in the
 *   tab the person started in (`CodeForm`); confirming signs in and this
 *   page renders again as the case above.
 * - **No session, no address:** a link opened a second time, or a dead one
 *   (`?error=`): `/signin` says so.
 */
export default async function VerifyEmail({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string; email?: string; resent?: string }>;
}) {
  const params = await searchParams;
  const next = safeReturnTo(params.next);
  if (params.error) redirect(authHref('/signin', next, { error: params.error }));

  const viewer = await viewerFromHeaders(await headers());
  const userId = viewer?.account.userId;
  if (!viewer || !userId) {
    if (!params.email) redirect(authHref('/signin', next, { error: LINK_USED }));
    return (
      <OnboardingCard title="Check your inbox">
        <CodeForm initialEmail={params.email} next={next} resent={params.resent === '1'} />
      </OnboardingCard>
    );
  }

  const [pending, missing] = await Promise.all([pendingBetFor(userId), missingFromUser(userId)]);
  if (!pending && !missing.name && !missing.password) redirect(next);

  const bet = pending ? await pendingBetView(pending) : null;
  return (
    <Finish bet={bet} email={viewer.email} needsName={missing.name} needsPassword={missing.password} next={next} />
  );
}

/** The pending bet as `Finish` shows it, on the market as it is now. */
async function pendingBetView(pending: StoredPendingBet): Promise<PendingBet> {
  const market = await resolveMarket(pending.marketId);
  const listing = market.listingId ? await resolveListing(market.listingId) : null;
  return {
    market: presentMarket(await marketView(market)) as z.output<typeof S.Market>,
    outcomeId: pending.outcomeId,
    stakeMicro: pending.stakeMicro.toString(),
    seenOrderCount: pending.seenOrderCount,
    orderKey: pendingBetOrderKey(pending),
    choseHere: choseHere(pending, (await cookies()).get(ONBOARDING_BROWSER_COOKIE)?.value),
    // The engine's own test: open, and before `closes_at`.
    tradable: market.status === 'open' && market.closesAt.getTime() > Date.now(),
    title: listing?.title ?? market.question,
    href: marketHref({ marketSlug: market.slug, listingSlug: listing?.slug ?? null }),
  };
}
