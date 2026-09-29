import { headers } from 'next/headers';
import { ui } from '@/components/ui';
import { rep } from '@/lib/format';
import { viewerFromHeaders } from '@/server/auth';
import * as events from '@/server/events';
import { leaderboard } from '@/server/views';

export const dynamic = 'force-dynamic';

/** Ranked on settled profit only; open markets count for nothing (§1.2). */
export default async function LeaderboardPage() {
  const { rows } = await leaderboard({ limit: 100 });
  const viewer = await viewerFromHeaders(await headers());
  events.log('leaderboard.read', { accountId: viewer?.account.id ?? null });

  return (
    <main className={ui.page}>
      <h2 className={ui.groupHeading}>Leaderboard · settled profit</h2>
      {rows.length === 0 ? (
        <div className={ui.empty}>No markets have settled yet.</div>
      ) : (
        <table className={ui.table}>
          <thead>
            <tr>
              <th className={ui.th()}>#</th>
              <th className={ui.th()}>Trader</th>
              <th className={ui.th()}>Institution</th>
              <th className={ui.th(true)}>Markets</th>
              <th className={ui.th(true)}>Settled profit</th>
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
                <td className={`${ui.td} text-muted`}>{r.institutionName ?? ''}</td>
                <td className={`${ui.td} ${ui.num}`}>{r.markets}</td>
                <td className={`${ui.td} ${ui.num}`}>{rep(r.pnlMicro)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
