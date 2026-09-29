import Link from 'next/link';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { pct, rep, shares } from '@/lib/format';
import { getPortfolio } from '@/server/accounts';
import { viewerFromHeaders } from '@/server/auth';
import * as events from '@/server/events';

export const dynamic = 'force-dynamic';

/**
 * Holdings, each with its mark and its quoted exit value in two separate
 * columns (§1.1). No net worth, and nothing here is a score (§1.2).
 */
export default async function PortfolioPage() {
  const viewer = await viewerFromHeaders(await headers());
  if (!viewer) redirect('/signin');
  const p = await getPortfolio(viewer.account.id);
  events.log('portfolio.read', { accountId: viewer.account.id });

  return (
    <main className="page">
      <h2 className="group">Portfolio</h2>
      <div className="kv" style={{ maxWidth: 320 }}>
        <span>Balance</span>
        <b className="mono">{rep(p.balanceMicro)} rep</b>
      </div>
      {p.holdings.length === 0 ? (
        <div className="empty">No open positions.</div>
      ) : (
        <table className="data">
          <thead>
            <tr>
              <th>Market</th>
              <th>Holding</th>
              <th className="n">Price</th>
              <th className="n">Marked at</th>
              <th className="n">Sell all now</th>
            </tr>
          </thead>
          <tbody>
            {p.holdings.map((h) => (
              <tr key={h.outcomeId}>
                <td>
                  <Link href={`/markets/${h.marketSlug}`}>{h.question}</Link>
                  {h.marketStatus !== 'open' && <span className="badge">{h.marketStatus}</span>}
                </td>
                <td className="mono">
                  {shares(h.sharesMicro)} {h.outcomeLabel}
                </td>
                <td className="n">{pct(h.price)}</td>
                <td className="n">{rep(h.markMicro)}</td>
                <td className="n">
                  <b>{rep(h.quotedExitMicro)}</b>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="fine">
        “Marked at” is shares × price. “Sell all now” is what selling the whole holding would actually pay; it is lower,
        because each share you sell moves the price against you.
      </p>
    </main>
  );
}
