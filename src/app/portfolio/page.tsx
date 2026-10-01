import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { OutcomeSwatch } from '@/components/OutcomeBar';
import { Pager } from '@/components/Pager';
import { PaperName } from '@/components/PaperName';
import { PositionsTable } from '@/components/PositionsTable';
import { TableNotes } from '@/components/TableNotes';
import { TitleBlock } from '@/components/TitleBlock';
import { ui } from '@/components/ui';
import { WorthTable } from '@/components/WorthTable';
import { day, rep, REP, shares, signedRep } from '@/lib/format';
import { presentPortfolio } from '@/server/api/present';
import { closedPositions, getPortfolio } from '@/server/accounts';
import { viewerFromHeaders } from '@/server/auth';
import * as events from '@/server/events';
import { tradingMarketIds } from '@/server/views';

export const dynamic = 'force-dynamic';

const CLOSED_PAGE = 50;
const CLOSED_BY = { sold: 'sold', won: 'settled, won', lost: 'settled, lost' } as const;

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
      <TitleBlock title="Portfolio" byline={`${viewer.account.displayName}, @${viewer.account.handle}`} />
      <h2 className={ui.groupHeading}>Summary</h2>
      <p className="mt-1 mb-2 text-[15px] text-subtle">
        Your cash, what your positions would sell for now, and what you have made or lost so far.
      </p>
      <WorthTable n={1} caption="Your reputation now." worth={s} />

      <h2 className={ui.groupHeading}>Open positions</h2>
      <p className="mt-1 mb-2 text-[15px] text-subtle">
        The outcomes you hold shares in. Each share pays 1 {REP} if its outcome wins. You can sell a position, or share
        it publicly.
      </p>
      {p.holdings.length === 0 ? (
        <div className={ui.empty}>No open positions.</div>
      ) : (
        <PositionsTable
          holdings={presentPortfolio(p).holdings}
          caption={
            <>
              <b>Table 2.</b> Your open positions, one row per outcome held.
            </>
          }
          showMarket
          sellable={sellable}
        />
      )}

      <h2 className={ui.groupHeading}>Closed positions</h2>
      <p className="mt-1 mb-2 text-[15px] text-subtle">
        The outcomes you no longer hold, either because you sold them or because the market was settled, and what each
        one made or lost.
      </p>
      {closed.total === 0 ? (
        <div className={ui.empty}>No closed positions yet.</div>
      ) : (
        <>
          <div className={ui.tableScroll}>
            <table className={ui.table}>
              <caption className={ui.tableCaption}>
                <b>{p.holdings.length === 0 ? 'Table 2.' : 'Table 3.'}</b> Outcomes you traded and no longer hold, over
                all their fills, newest first.
              </caption>
              <thead>
                <tr>
                  <th className={ui.th()}>Position</th>
                  <th className={`${ui.th(true)} pl-6 whitespace-nowrap`}>Paid ({REP})</th>
                  <th className={`${ui.th(true)} pl-6 whitespace-nowrap`}>
                    Return ({REP})<sup className={ui.mark}>a</sup>
                  </th>
                  <th className={`${ui.th(true)} pl-6 whitespace-nowrap`}>P&L ({REP})</th>
                  <th className={`${ui.th()} pl-6`}>Closed</th>
                </tr>
              </thead>
              <tbody>
                {closed.rows.map((c) => (
                  <tr key={c.outcomeId}>
                    {/* The title has a line of its own and the shares bought sit under it; as the open positions' table. */}
                    <td className={`${ui.td} w-full max-w-0`}>
                      <PaperName m={c} />
                      <span className="block font-mono text-[13px] whitespace-nowrap text-muted">
                        <OutcomeSwatch ordinal={c.outcomeOrdinal} outcomes={c.outcomeCount} />
                        {shares(c.boughtMicro, 2)} {c.outcomeLabel}
                      </span>
                    </td>
                    <td className={`${ui.td} ${ui.num} pl-6`}>{rep(c.paidMicro)}</td>
                    <td
                      className={`${ui.td} ${ui.num} pl-6`}
                      title={`sold for ${rep(c.soldMicro)}${c.closedBy === 'sold' ? '' : `, settlement paid ${rep(c.payoutMicro)}`}`}
                    >
                      {rep(c.soldMicro + c.payoutMicro)}
                    </td>
                    <td className={`${ui.td} ${ui.num} pl-6 ${ui.pnl(c.pnlMicro)}`}>{signedRep(c.pnlMicro)}</td>
                    <td className={`${ui.td} pl-6 text-[13px] whitespace-nowrap`}>
                      {day(c.closedAt)} <span className="text-muted">{CLOSED_BY[c.closedBy]}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <TableNotes
            notes={[
              [
                'a',
                <>
                  What selling paid plus, if you held into settlement, 1 {REP} per winning share. Hover a figure for the
                  split.
                </>,
              ],
            ]}
          />
          <Pager page={page} pages={pages} href={(n) => `/portfolio?page=${n}`} />
        </>
      )}
    </main>
  );
}
