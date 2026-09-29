import Link from 'next/link';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { Stat } from '@/components/Stat';
import { ui } from '@/components/ui';
import { pct, rep, shares, signedRep } from '@/lib/format';
import { getPortfolio, type Holding } from '@/server/accounts';
import { viewerFromHeaders } from '@/server/auth';
import * as events from '@/server/events';

export const dynamic = 'force-dynamic';

function holdingHref(h: Pick<Holding, 'marketSlug' | 'listingSlug'>): string {
  return h.listingSlug ? `/papers/${h.listingSlug}?market=${encodeURIComponent(h.marketSlug)}` : `/markets/${h.marketSlug}`;
}

/**
 * Cash, net worth at liquidation value, and P&L, then the holdings — each
 * with its mark and its quoted exit value in two separate columns (§1.1). The
 * mark-based net worth (§1.2) is not shown.
 */
export default async function PortfolioPage() {
  const viewer = await viewerFromHeaders(await headers());
  if (!viewer) redirect('/signin?next=/portfolio');
  const p = await getPortfolio(viewer.account.id);
  events.log('portfolio.read', { accountId: viewer.account.id });
  const s = p.summary;

  return (
    <main className={ui.page}>
      <h2 className={ui.groupHeading}>Portfolio</h2>
      <div className="mt-2 flex flex-wrap gap-x-9 gap-y-2">
        <Stat label="Cash" value={rep(s.cashMicro)} />
        <Stat label="Net worth" value={rep(s.netWorthMicro)} title="Cash plus what selling every holding now would pay" />
        <Stat
          label="Unrealized P&L"
          value={signedRep(s.unrealizedPnlMicro)}
          tone={ui.pnl(s.unrealizedPnlMicro)}
          title="What selling everything now would make on markets not yet settled"
        />
        <Stat
          label="Realized P&L"
          value={signedRep(s.realizedPnlMicro)}
          tone={ui.pnl(s.realizedPnlMicro)}
          title="Profit on settled markets"
        />
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
                  <Link href={holdingHref(h)}>{h.question}</Link>
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
        because each share you sell moves the price against you. Net worth and unrealized P&L use “sell all now”, never
        the mark.
      </p>
    </main>
  );
}
