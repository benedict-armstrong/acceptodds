import type { Metadata } from 'next';
import Link from 'next/link';
import { headers } from 'next/headers';
import { SignOut } from '@/components/SignOut';
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
        <header className="site-header">
          <Link href="/" className="logo">
            paper<i>market</i>
          </Link>
          <span className="spacer" />
          <nav>
            <Link href="/leaderboard">leaderboard</Link>
            {viewer ? (
              <>
                <Link href="/portfolio">portfolio</Link>
                <span className="mono" title="your balance">
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
