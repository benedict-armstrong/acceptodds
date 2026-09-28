import { headers } from 'next/headers';
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
    <main className="page">
      <h2 className="group">Leaderboard · settled profit</h2>
      {rows.length === 0 ? (
        <div className="empty">No markets have settled yet.</div>
      ) : (
        <table className="data">
          <thead>
            <tr>
              <th>#</th>
              <th>Trader</th>
              <th>Institution</th>
              <th className="n">Markets</th>
              <th className="n">Settled profit</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.accountId}>
                <td className="mono">{r.rank}</td>
                <td>
                  {r.displayName}
                  {r.isBot && <span className="badge">bot</span>}
                </td>
                <td className="muted">{r.institutionName ?? ''}</td>
                <td className="n">{r.markets}</td>
                <td className="n">{rep(r.pnlMicro)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
