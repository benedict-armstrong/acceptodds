import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { MathText } from '@/components/MathText';
import { Confetti } from '@/components/Confetti';
import { OnboardingCard } from '@/components/OnboardingCard';
import { RememberVenue } from '@/components/RememberVenue';
import { pct, rep, REP } from '@/lib/format';
import { shareText } from '@/lib/headline';
import { FIRST_TRADE_PATH, marketHref } from '@/lib/links';
import { authHref, VERIFY_EMAIL } from '@/lib/return-to';
import { viewerFromHeaders } from '@/server/auth';
import { currentVenue } from '@/server/current-venue';
import { missingFromUser } from '@/server/better-auth';
import { shareSubject, siteName, siteUrl } from '@/server/share';
import { firstFill, marketView, resolveMarket } from '@/server/views';
import { InviteFriends } from './InviteFriends';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Your first trade' };

/**
 * Where an account lands after its first trade (`Fill.firstTrade`, followed by
 * `useOrder`, or by `Finish` as soon as a sign-up's bet is placed): the trade
 * as the database has it and how it moved that outcome's price, with confetti, then an ask to share that market with a friend
 * (its BibTeX entry, as the paper's share button copies: prices, never the
 * trader's stake, §1.1, #18), then on to its
 * paper — by way of `/verify-email` while a name or password is still owed,
 * since the bet is placed before those are asked for.
 * Read from `orders`, so it is the same whenever it is opened; before any
 * trade there is nothing to show and it goes home.
 */
export default async function FirstTradePage() {
  const viewer = await viewerFromHeaders(await headers());
  if (!viewer) redirect(authHref('/signin', FIRST_TRADE_PATH));
  const fill = await firstFill(viewer.account.id);
  if (!fill) redirect('/');
  const paper = marketHref({ marketSlug: fill.marketSlug, listingSlug: fill.listingSlug });
  const userId = viewer.account.userId;
  const owed = userId ? await missingFromUser(userId) : { name: false, password: false };
  // The traded market's link: the short `/s/` one when it is what that resolves to.
  const view = await marketView(await resolveMarket(fill.marketId));
  const sharePath =
    !fill.listingSlug || view.market.isMain ? ((await shareSubject(fill.marketId))?.sharePath ?? paper) : paper;
  const shareUrl = new URL(sharePath, siteUrl()).href;
  const citation = shareText({
    title: fill.listingTitle ?? fill.question,
    kind: fill.kind,
    url: shareUrl,
    status: view.market.status,
    prices: view.outcomes.map((o) => o.price),
    year: new Date().getFullYear(),
  });
  // A small trade in a deep market can move less than a point: then a decimal shows it moved.
  const precise = pct(fill.priceBefore) === pct(fill.priceAfter);
  const href = owed.name || owed.password ? authHref(VERIFY_EMAIL, paper) : paper;

  return (
    <OnboardingCard title="Congratulations on your first trade!">
      <p className="mb-4">
        <MathText text={fill.listingTitle ?? fill.question} />
        <span className="block text-muted">
          {fill.kind}, {rep(fill.costMicro)} {REP} on {fill.label}
        </span>
      </p>
      <p className="mb-4">
        You moved the market: the chance of <strong>{fill.label}</strong> went from{' '}
        <span className="font-mono">{pct(fill.priceBefore, precise)}</span> to{' '}
        <span className="font-mono">{pct(fill.priceAfter, precise)}</span>.
      </p>
      <Confetti />
      {/* The trade's venue becomes the navbar's. */}
      <RememberVenue kind={fill.kind} stale={fill.kind !== (await currentVenue())} />
      <InviteFriends
        siteName={siteName()}
        url={shareUrl}
        citation={citation}
        venue={fill.kind}
        next={{
          href,
          label: href !== paper ? 'Continue' : fill.listingSlug ? 'Continue to the paper' : 'Continue to the market',
        }}
      />
    </OnboardingCard>
  );
}
