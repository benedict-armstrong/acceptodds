import Link from 'next/link';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { SignOut } from '@/components/SignOut';
import { Stat } from '@/components/Stat';
import { ui } from '@/components/ui';
import { day, rep, signedRep } from '@/lib/format';
import { viewerFromHeaders } from '@/server/auth';
import * as events from '@/server/events';
import { valuation } from '@/server/valuation';

export const dynamic = 'force-dynamic';

/** The signed-in viewer's own account. Read-only; signing out goes through Better Auth's client. */
export default async function ProfilePage() {
  const viewer = await viewerFromHeaders(await headers());
  if (!viewer) redirect('/signin');
  const a = viewer.account;
  const v = await valuation(a.id);
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

      <hr className="my-6 border-rule-soft" />
      <SignOut className={ui.btn({ ghost: true })} />
    </main>
  );
}
