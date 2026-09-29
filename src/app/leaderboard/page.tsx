import Link from 'next/link';
import { headers } from 'next/headers';
import { ui } from '@/components/ui';
import { rep, signedRep } from '@/lib/format';
import { viewerFromHeaders } from '@/server/auth';
import * as events from '@/server/events';
import { leaderboard, type LeaderboardBasis } from '@/server/views';

export const dynamic = 'force-dynamic';

const TABS: { basis: LeaderboardBasis; label: string }[] = [
  { basis: 'net_worth', label: 'net worth' },
  { basis: 'settled_pnl', label: 'settled profit' },
];

/**
 * Two rankings. "Net worth" is **liquidation value** — cash plus what selling
 * every open holding now would pay — which a trader cannot inflate with their
 * own price impact. The mark-based net worth of §1.2 is never shown here.
 * "Settled profit" counts settled markets only. The UI opens on net worth;
 * the API's default basis stays `settled_pnl`.
 */
export default async function LeaderboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const basis: LeaderboardBasis = sp.basis === 'settled_pnl' ? 'settled_pnl' : 'net_worth';
  const { rows } = await leaderboard({ basis, limit: 100 });
  const viewer = await viewerFromHeaders(await headers());
  events.log('leaderboard.read', { accountId: viewer?.account.id ?? null });

  return (
    <main className={ui.page}>
      <div className="flex flex-wrap items-baseline gap-x-4.5">
        <h2 className={ui.groupHeading}>Leaderboard</h2>
        <span className="flex gap-3 font-sans text-[13px] text-muted">
          {TABS.map((t) => (
            <Link key={t.basis} href={t.basis === 'net_worth' ? '/leaderboard' : `/leaderboard?basis=${t.basis}`} className={t.basis === basis ? ui.on : ''}>
              {t.label}
            </Link>
          ))}
        </span>
      </div>
      {rows.length === 0 ? (
        <div className={ui.empty}>{basis === 'settled_pnl' ? 'No markets have settled yet.' : 'No traders yet.'}</div>
      ) : (
        <table className={ui.table}>
          <thead>
            <tr>
              <th className={ui.th()}>#</th>
              <th className={ui.th()}>Trader</th>
              <th className={`${ui.th()} narrow:hidden`}>Institution</th>
              <th className={ui.th(true)} title="Cash plus what selling every open holding now would pay">
                Net worth
              </th>
              <th className={ui.th(true)} title="On markets not yet settled, if sold now">
                Unrealized
              </th>
              <th className={ui.th(true)} title="On settled markets">
                Settled
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.accountId}>
                <td className={`${ui.td} font-mono text-[13px]`}>{r.rank}</td>
                <td className={ui.td}>
                  {r.displayName}
                  {r.isBot && <span className={ui.badge}>bot</span>}
                </td>
                <td className={`${ui.td} text-muted narrow:hidden`}>{r.institutionName ?? ''}</td>
                <td className={`${ui.td} ${ui.num}`}>{rep(r.netWorthMicro)}</td>
                <td className={`${ui.td} ${ui.num} ${ui.pnl(r.unrealizedPnlMicro)}`}>{signedRep(r.unrealizedPnlMicro)}</td>
                <td className={`${ui.td} ${ui.num} ${ui.pnl(r.settledPnlMicro)}`}>{signedRep(r.settledPnlMicro)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className={`${ui.fine} mb-3`}>
        Net worth is cash plus what selling every open holding right now would actually pay — not holdings marked at the
        current price, which a trader could inflate by pushing the price themselves. Unrealized is what selling now would
        make on markets not yet settled; settled is profit on markets that have resolved.
      </p>
    </main>
  );
}
