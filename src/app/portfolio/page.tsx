import Link from 'next/link';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { Pager } from '@/components/Pager';
import { holdingHref, PositionsTable } from '@/components/PositionsTable';
import { Stat } from '@/components/Stat';
import { ui } from '@/components/ui';
import { day, rep, REP, shares, signedRep } from '@/lib/format';
import { presentPortfolio } from '@/server/api/present';
import { closedPositions, getPortfolio } from '@/server/accounts';
import { viewerFromHeaders } from '@/server/auth';
import * as events from '@/server/events';
import { tradingMarketIds } from '@/server/views';

export const dynamic = 'force-dynamic';

const CLOSED_PAGE = 50;
const CLOSED_BY = { sold: 'sold', won: 'settled · won', lost: 'settled · lost' } as const;

/**
 * Cash, net worth at liquidation value, and P&L, then the open positions in
 * the same `PositionsTable` as a market's page, with a market column and a
 * sell button on every open market (never a mark, §1.1). The mark-based net
 * worth (§1.2) is not shown. Then the closed positions (#22),
 * 50 a page on `?page=`.
 */
export default async function PortfolioPage({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  const viewer = await viewerFromHeaders(await headers());
  if (!viewer) redirect('/signin?next=/portfolio');
  const requested = Math.max(1, Math.floor(Number((await searchParams).page)) || 1);
  const p = await getPortfolio(viewer.account.id);
  let closed = await closedPositions(viewer.account.id, { limit: CLOSED_PAGE, offset: (requested - 1) * CLOSED_PAGE });
  const pages = Math.max(1, Math.ceil(closed.total / CLOSED_PAGE));
  // A page past the end serves the last page.
  const page = Math.min(requested, pages);
  if (page !== requested) {
    closed = await closedPositions(viewer.account.id, { limit: CLOSED_PAGE, offset: (page - 1) * CLOSED_PAGE });
  }
  events.log('portfolio.read', { accountId: viewer.account.id });
  const s = p.summary;
  const canTrade = viewer.account.isBot || viewer.account.verifiedAt !== null;
  const sellable = canTrade ? await tradingMarketIds([...new Set(p.holdings.map((h) => h.marketId))]) : [];

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
        <PositionsTable
          holdings={presentPortfolio(p).holdings}
          caption={
            <>
              <b>Table 1.</b> Your open positions, one row per outcome held.
            </>
          }
          showMarket
          sellable={sellable}
        />
      )}
      <p className={`${ui.fine} mb-3`}>
        “Bought @” is the average price you paid. “Current value” is what selling it all now would pay against what it
        cost; it starts a little negative, because each share you sell moves the price against you. Net worth and
        unrealized P&L use the same sell-all value.
      </p>

      <h2 className={ui.groupHeading}>Closed positions</h2>
      {closed.total === 0 ? (
        <div className={ui.empty}>No closed positions yet.</div>
      ) : (
        <>
          <table className={ui.table}>
            <caption className={ui.tableCaption}>
              <b>{p.holdings.length === 0 ? 'Table 1.' : 'Table 2.'}</b> Outcomes you traded and no longer hold, newest first.
            </caption>
            <thead>
              <tr>
                <th className={ui.th()}>Market</th>
                <th className={ui.th()}>Bought</th>
                <th className={ui.th(true)}>Paid</th>
                <th className={ui.th(true)}>Got back</th>
                <th className={ui.th(true)}>P&L</th>
                <th className={ui.th()}>Closed</th>
              </tr>
            </thead>
            <tbody>
              {closed.rows.map((c) => (
                <tr key={c.outcomeId}>
                  <td className={ui.td}>
                    <Link href={holdingHref(c)}>{c.question}</Link>
                  </td>
                  <td className={`${ui.td} font-mono text-[13px]`}>
                    {shares(c.boughtMicro)} {c.outcomeLabel}
                  </td>
                  <td className={`${ui.td} ${ui.num}`}>{rep(c.paidMicro)}</td>
                  <td
                    className={`${ui.td} ${ui.num}`}
                    title={`sold for ${rep(c.soldMicro)}${c.closedBy === 'sold' ? '' : `, settlement paid ${rep(c.payoutMicro)}`}`}
                  >
                    {rep(c.soldMicro + c.payoutMicro)}
                  </td>
                  <td className={`${ui.td} ${ui.num} ${ui.pnl(c.pnlMicro)}`}>{signedRep(c.pnlMicro)}</td>
                  <td className={`${ui.td} text-[13px] whitespace-nowrap`}>
                    {day(c.closedAt)} <span className="text-muted">{CLOSED_BY[c.closedBy]}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <Pager page={page} pages={pages} href={(n) => `/portfolio?page=${n}`} />
          <p className={`${ui.fine} mb-3`}>
            An outcome you traded and hold none of now, over all its fills. “Got back” is what selling paid plus, if you
            held into settlement, 1 {REP} per winning share.
          </p>
        </>
      )}
    </main>
  );
}
