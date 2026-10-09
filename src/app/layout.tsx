import type { Metadata } from 'next';
import Link from 'next/link';
import { headers } from 'next/headers';
import { Analytics } from '@/components/Analytics';
import { AuthNavLink } from '@/components/AuthLinks';
import { ConfirmBanner } from '@/components/ConfirmBanner';
import { HomeLink } from '@/components/HomeLink';
import { LogoMark } from '@/components/Logo';
import { NavGroups } from '@/components/NavGroups';
import { groupsOf } from '@/server/groups';
import { NameBanner } from '@/components/NameBanner';
import { NavWorth, type NavStanding } from '@/components/NavWorth';
import { PendingGroupJoin } from '@/components/PendingGroupJoin';
import { rep, REP } from '@/lib/format';
import { microToFloat } from '@/lib/money';
import { viewerFromHeaders } from '@/server/auth';
import { currentVenue } from '@/server/current-venue';
import { startingBalanceMicro } from '@/server/wallets';
import { siteName, siteUrl, venuePreviewImages } from '@/server/share';
import { valuation } from '@/server/valuation';
import { mapKinds, marketKinds } from '@/server/views';
import { fieldSnapshot, type FieldSnapshot } from '@/server/field-snapshot';
import { VenueSwitcher } from '@/components/VenueSwitcher';
import { Wordmark } from '@/components/Wordmark';
import 'katex/dist/katex.min.css';
import './globals.css';

export async function generateMetadata(): Promise<Metadata> {
  return {
    // Absolute URLs for the link previews (issue #11).
    metadataBase: new URL(siteUrl()),
    title: 'acceptodds',
    description: 'A prediction market on the fate of research papers, traded in reputation.',
    applicationName: siteName(),
    // The default venue's card, for every page without a preview of its own.
    openGraph: { siteName: siteName(), type: 'website', images: venuePreviewImages(null) },
    twitter: { card: 'summary_large_image', images: venuePreviewImages(null) },
    // Agents find the machine-readable docs from any page.
    alternates: { types: { 'application/json': '/api/v1/openapi.json' } },
  };
}

/**
 * Page analytics, when `UMAMI_URL` and `UMAMI_WEBSITE_ID` are both set: read
 * per request, so turning it on or off is an env change and a restart, not a
 * rebuild. Counts only on `APP_URL`'s host.
 */
function analytics(): { src: string; websiteId: string; domain: string } | null {
  const url = process.env.UMAMI_URL?.trim().replace(/\/+$/, '');
  const websiteId = process.env.UMAMI_WEBSITE_ID?.trim();
  if (!url || !websiteId) return null;
  return { src: `${url}/script.js`, websiteId, domain: new URL(siteUrl()).hostname };
}

/**
 * The navbar's picture of where the viewer stands on the net-worth board: the
 * shared snapshot's curve (`server/field-snapshot.ts`, the same for everyone
 * and never valued per viewer), every third point, and the viewer placed on
 * it by their own live net worth. Floats for plotting only.
 */
function navStanding(field: FieldSnapshot, mine: bigint): NavStanding | null {
  if (field.worthsMicro.length === 0) return null;
  const [lo, hi] = field.domain;
  const you = microToFloat(mine) / 1_000_000;
  return {
    curve: field.curve.filter((_, i) => i % 3 === 0).map((y) => Number(y.toFixed(3))),
    at: hi > lo ? Math.min(1, Math.max(0, (you - lo) / (hi - lo))) : 0.5,
  };
}

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const viewer = await viewerFromHeaders(await headers());
  // Liquidation value, not a mark (§1.1, §1.2): what the viewer would hold if they sold everything now,
  // in the venue they are browsing — each venue is a wallet of its own.
  const [kind, kinds, mapped] = await Promise.all([currentVenue(), marketKinds(), mapKinds()]);
  // Each venue has its own map, or none: no link to a map that is not there.
  const hasMap = mapped.includes(kind);
  const [worth, memberships] = viewer
    ? await Promise.all([valuation(viewer.account.id, kind), groupsOf(viewer.account.id)])
    : [null, []];
  const readingGroups = memberships.map(({ group }) => ({ id: group.id, name: group.name }));
  const standing = viewer && worth ? navStanding(await fieldSnapshot(kind), worth.netWorthMicro) : null;
  const tracker = analytics();
  return (
    <html lang="en">
      <body>
        {/* On a phone, keep the mini distribution beside a menu containing every navigation link. */}
        <header className="flex flex-wrap items-baseline gap-x-4.5 gap-y-1.5 px-6 pt-4 pb-2.5 narrow:px-4">
          {/* The venue beside the logo, set like a journal's name and volume: it scopes the whole site —
              wallet, curve, lists and boards. */}
          <span className="flex min-w-0 items-baseline gap-x-2">
            <HomeLink className="text-[22px]">
              <LogoMark />
              <span className="ml-2 narrow:hidden">
                <Wordmark />
              </span>
            </HomeLink>
            {/* Raised a little off the shared baseline: at 18px beside the 22px wordmark it otherwise reads low. */}
            <span className="relative -top-0.5 flex items-baseline gap-x-2">
              <span aria-hidden className="text-lg text-rule-strong">
                /
              </span>
              <VenueSwitcher current={kind} kinds={kinds.map((k) => k.kind)} />
            </span>
          </span>
          <span className="flex-1" />
          <nav
            aria-label="Main navigation"
            className={`flex flex-wrap items-baseline gap-x-4.5 gap-y-1 text-sm ${viewer ? 'narrow:items-center narrow:gap-x-1' : 'narrow:gap-x-3.5'}`}
          >
            <div className={`flex items-baseline gap-x-4.5 ${viewer ? 'narrow:hidden' : 'narrow:gap-x-3.5'}`}>
              {hasMap && <Link href="/map">map</Link>}
              <Link href="/leaderboard">leaderboard</Link>
              {viewer && <Link href="/portfolio">portfolio</Link>}
              <NavGroups groups={readingGroups} />
            </div>
            {viewer ? (
              <>
                <NavWorth
                  groups={readingGroups}
                  handle={viewer.account.handle}
                  worth={`${rep(worth?.netWorthMicro ?? startingBalanceMicro())} ${REP}`}
                  cash={`${rep(worth?.cashMicro ?? startingBalanceMicro())} ${REP}`}
                  pnlMicro={((worth?.unrealizedPnlMicro ?? 0n) + (worth?.realizedPnlMicro ?? 0n)).toString()}
                  standing={standing}
                  hasMap={hasMap}
                />
                <Link href="/profile" className="narrow:hidden">
                  profile
                </Link>
              </>
            ) : (
              <AuthNavLink />
            )}
          </nav>
        </header>
        <ConfirmBanner signedIn={viewer !== null} />
        <PendingGroupJoin signedIn={viewer !== null} />
        {viewer && (
          <NameBanner
            needsName={viewer.needsName}
            displayName={viewer.account.displayName}
            handle={viewer.account.handle}
          />
        )}
        {children}
        {tracker && <Analytics {...tracker} />}
      </body>
    </html>
  );
}
