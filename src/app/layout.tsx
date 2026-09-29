import type { Metadata } from 'next';
import Link from 'next/link';
import { headers } from 'next/headers';
import { LogoMark } from '@/components/Logo';
import { SignOut } from '@/components/SignOut';
import { ui } from '@/components/ui';
import { rep } from '@/lib/format';
import { viewerFromHeaders } from '@/server/auth';
import './globals.css';

export const metadata: Metadata = {
  title: 'papermarket',
  description: 'A prediction market on the fate of research papers, traded in reputation.',
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const viewer = await viewerFromHeaders(await headers());
  return (
    <html lang="en">
      <body>
        <header className="flex items-baseline gap-4.5 border-b border-rule px-6 pt-4 pb-2.5">
          <Link href="/" className="text-[22px]">
            <LogoMark />
            <span>
              paper<i className="text-accent not-italic">market</i>
            </span>
          </Link>
          <span className="flex-1" />
          <nav className="flex items-baseline gap-4.5 text-sm">
            <Link href="/leaderboard">leaderboard</Link>
            {viewer ? (
              <>
                <Link href="/portfolio">portfolio</Link>
                <span className={ui.mono} title="your balance">
                  {rep(viewer.account.balanceMicro)} rep
                </span>
                <SignOut />
              </>
            ) : (
              <>
                <Link href="/signin">sign in</Link>
                <Link href="/signup">sign up</Link>
              </>
            )}
          </nav>
        </header>
        {children}
      </body>
    </html>
  );
}
