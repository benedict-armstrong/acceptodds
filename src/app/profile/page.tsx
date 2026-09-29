import Link from 'next/link';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { FollowStar } from '@/components/FollowStar';
import { MathText } from '@/components/MathText';
import { SignOut } from '@/components/SignOut';
import { Stat } from '@/components/Stat';
import { ui } from '@/components/ui';
import { minMovePp, movePp } from '@/lib/digest';
import { day, pct, rep, signedRep } from '@/lib/format';
import { viewerFromHeaders } from '@/server/auth';
import * as events from '@/server/events';
import { followedListings } from '@/server/follows';
import { valuation } from '@/server/valuation';
import { DigestToggle } from './DigestToggle';

export const dynamic = 'force-dynamic';

/** The signed-in viewer's own account. Read-only; signing out goes through Better Auth's client. */
export default async function ProfilePage() {
  const viewer = await viewerFromHeaders(await headers());
  if (!viewer) redirect('/signin?next=/profile');
  const a = viewer.account;
  const v = await valuation(a.id);
  const follows = await followedListings(a.id);
  events.log('me.read', { accountId: a.id });

  return (
    <main className={`${ui.page} max-w-[560px]`}>
      <h2 className={ui.groupHeading}>Profile</h2>
      <h1 className="mt-1 text-[26px] leading-tight font-normal">
        {a.displayName}
        {a.isBot && <span className={ui.badge}>bot</span>}
      </h1>
      <div className={`${ui.mono} text-muted`}>@{a.handle}</div>

      <div className="mt-4 space-y-1 font-sans text-sm">
        <div className={ui.kv}>
          <span>Email</span>
          <span>{viewer.email}</span>
        </div>
        <div className={ui.kv}>
          <span>Institution</span>
          <span>{a.institutionName ?? '—'}</span>
        </div>
        <div className={ui.kv}>
          <span>Verified</span>
          <span className={a.verifiedAt ? 'text-up' : 'text-muted'}>
            {a.verifiedAt ? `yes, ${day(a.verifiedAt)}` : 'no — you may browse but not trade'}
          </span>
        </div>
        <div className={ui.kv}>
          <span>Account type</span>
          <span>{a.isBot ? 'bot' : 'person'}{viewer.isAdmin ? ' · admin' : ''}</span>
        </div>
        <div className={ui.kv}>
          <span>Joined</span>
          <span>{day(a.createdAt)}</span>
        </div>
      </div>

      {v && (
        <div className="mt-5 flex flex-wrap gap-x-9 gap-y-2">
          <Stat label="Cash" value={rep(v.cashMicro)} />
          <Stat label="Net worth" value={rep(v.netWorthMicro)} title="Cash plus what selling every holding now would pay" />
          <Stat label="Unrealized P&L" value={signedRep(v.unrealizedPnlMicro)} tone={ui.pnl(v.unrealizedPnlMicro)} />
          <Stat label="Realized P&L" value={signedRep(v.realizedPnlMicro)} tone={ui.pnl(v.realizedPnlMicro)} />
        </div>
      )}
      <div className="mt-3 flex gap-4.5 font-sans text-sm">
        <Link href="/portfolio">portfolio →</Link>
        <Link href="/leaderboard">leaderboard →</Link>
      </div>

      <section className="mt-7">
        <h3 className={ui.sectionHeading}>Following</h3>
        {follows.length === 0 && (
          <div className="py-2 text-[15px] text-muted italic">
            Star a paper to follow it: <span className="not-italic">☆</span> on its page or in the list.
          </div>
        )}
        {follows.map((f) => {
          const pp = f.move ? Math.round(movePp(f.move)) : 0;
          return (
            <div
              key={f.view.listing.id}
              className="grid grid-cols-[18px_1fr_auto] items-baseline gap-x-2.5 border-b border-dotted border-rule-strong py-1.5"
            >
              <FollowStar listingId={f.view.listing.id} following />
              <Link
                href={`/papers/${encodeURIComponent(f.view.listing.slug)}`}
                className="line-clamp-2 leading-[1.35]"
                title={f.view.listing.title}
              >
                <MathText text={f.view.listing.title} />
              </Link>
              <span className="text-right font-mono text-[13px] whitespace-nowrap" title="price now; change over 24 hours">
                {f.move && f.main ? (
                  <>
                    <span className="font-serif text-sm">accept </span>
                    {pct(f.move.now)}{' '}
                    <span className={pp > 0 ? 'text-up' : pp < 0 ? 'text-down' : 'text-muted'}>
                      {pp > 0 ? '+' : pp < 0 ? '−' : '±'}
                      {Math.abs(pp)} pp
                    </span>
                  </>
                ) : (
                  <span className="text-muted">—</span>
                )}
              </span>
            </div>
          );
        })}
        {follows.length > 0 && (
          <div className="mt-2 font-sans text-sm">
            <Link href="/?following=1&kind=all&status=all">followed papers on the home page →</Link>
          </div>
        )}
      </section>

      <section id="email" className="mt-7">
        <h3 className={ui.sectionHeading}>Email</h3>
        <DigestToggle optIn={a.digestOptIn} minMovePp={minMovePp()} />
      </section>

      <hr className="my-6 border-rule-soft" />
      <SignOut className={ui.btn({ ghost: true })} />
    </main>
  );
}
