import Link from 'next/link';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { ui } from '@/components/ui';
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
    <main className={ui.page}>
      <h2 className={ui.groupHeading}>Portfolio</h2>
      <div className={`${ui.kv} max-w-[320px]`}>
        <span>Balance</span>
        <b className={ui.mono}>{rep(p.balanceMicro)} rep</b>
      </div>
      {p.holdings.length === 0 ? (
        <div className={ui.empty}>No open positions.</div>
      ) : (
        <table className={ui.table}>
          <thead>
            <tr>
              <th className={ui.th()}>Market</th>
              <th className={ui.th()}>Holding</th>
              <th className={ui.th(true)}>Price</th>
              <th className={ui.th(true)}>Marked at</th>
              <th className={ui.th(true)}>Sell all now</th>
            </tr>
          </thead>
          <tbody>
            {p.holdings.map((h) => (
              <tr key={h.outcomeId}>
                <td className={ui.td}>
                  <Link href={`/markets/${h.marketSlug}`}>{h.question}</Link>
                  {h.marketStatus !== 'open' && <span className={ui.badge}>{h.marketStatus}</span>}
                </td>
                <td className={`${ui.td} font-mono text-[13px]`}>
                  {shares(h.sharesMicro)} {h.outcomeLabel}
                </td>
                <td className={`${ui.td} ${ui.num}`}>{pct(h.price)}</td>
                <td className={`${ui.td} ${ui.num}`}>{rep(h.markMicro)}</td>
                <td className={`${ui.td} ${ui.num}`}>
                  <b>{rep(h.quotedExitMicro)}</b>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className={`${ui.fine} mb-3`}>
        “Marked at” is shares × price. “Sell all now” is what selling the whole holding would actually pay; it is lower,
        because each share you sell moves the price against you.
      </p>
    </main>
  );
}
