import type { Metadata } from 'next';
import Link from 'next/link';
import { headers } from 'next/headers';
import { AuthLinks } from '@/components/AuthLinks';
import { ConfirmBanner } from '@/components/ConfirmBanner';
import { LogoMark } from '@/components/Logo';
import { NavWorth, type NavStanding } from '@/components/NavWorth';
import { rep, REP } from '@/lib/format';
import { placeIn } from '@/lib/leaderboard';
import { microToFloat } from '@/lib/money';
import { viewerFromHeaders } from '@/server/auth';
import { siteUrl } from '@/server/share';
import { valuation } from '@/server/valuation';
import { fieldSnapshot, type FieldSnapshot } from '@/server/field-snapshot';
import 'katex/dist/katex.min.css';
import './globals.css';

export async function generateMetadata(): Promise<Metadata> {
  return {
    // Absolute URLs for the link previews (issue #11).
    metadataBase: new URL(siteUrl()),
    title: 'acceptodds',
    description: 'A prediction market on the fate of research papers, traded in reputation.',
  };
}

/**
 * The navbar's picture of where the viewer stands on the net-worth board: the
 * shared snapshot's curve (`server/field-snapshot.ts`, the same for everyone
 * and never valued per viewer), every third point, and the viewer placed on
 * it by their own live net worth. Floats for plotting only.
 */
function navStanding(field: FieldSnapshot, mine: bigint): NavStanding | null {
  if (field.worthsMicro.length === 0) return null;
  const { rank, fieldSize, percentAhead } = placeIn(field.worthsMicro, mine, 1);
  const [lo, hi] = field.domain;
  const you = microToFloat(mine) / 1_000_000;
  return {
    curve: field.curve.filter((_, i) => i % 3 === 0).map((y) => Number(y.toFixed(3))),
    at: hi > lo ? Math.min(1, Math.max(0, (you - lo) / (hi - lo))) : 0.5,
    rank: `about #${rank} of ${fieldSize}`,
    ahead: percentAhead === null ? null : `ahead of ${percentAhead.toFixed(1)}% of traders`,
  };
}

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const viewer = await viewerFromHeaders(await headers());
  // Liquidation value, not a mark (§1.1, §1.2): what the viewer would hold if they sold everything now.
  const worth = viewer ? await valuation(viewer.account.id) : null;
  const standing = viewer
    ? navStanding(await fieldSnapshot(), worth?.netWorthMicro ?? viewer.account.balanceMicro)
    : null;
  return (
    <html lang="en">
      <body>
        <header className="flex items-baseline gap-4.5 border-b border-rule px-6 pt-4 pb-2.5">
          <Link href="/" className="text-[22px]">
            <LogoMark />
            <span>
              accept<i className="text-accent not-italic">odds</i>
            </span>
          </Link>
          <span className="flex-1" />
          <nav className="flex items-baseline gap-4.5 text-sm">
            <Link href="/leaderboard">leaderboard</Link>
            {viewer ? (
              <>
                <Link href="/portfolio">portfolio</Link>
                <NavWorth
                  worth={`${rep(worth?.netWorthMicro ?? viewer.account.balanceMicro)} ${REP}`}
                  cash={`${rep(worth?.cashMicro ?? viewer.account.balanceMicro)} ${REP}`}
                  standing={standing}
                />
                <Link href="/profile">profile</Link>
              </>
            ) : (
              <AuthLinks />
            )}
          </nav>
        </header>
        <ConfirmBanner signedIn={viewer !== null} />
        {children}
      </body>
    </html>
  );
}
