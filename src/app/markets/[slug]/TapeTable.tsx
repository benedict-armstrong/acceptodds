'use client';

import type { z } from 'zod';
import { OutcomeSwatch } from '@/components/OutcomeBar';
import { TableNotes } from '@/components/TableNotes';
import { ui } from '@/components/ui';
import { ago, pct, shares } from '@/lib/format';
import type * as S from '@/server/api/schemas';

type Market = z.output<typeof S.Market>;
type Tape = z.output<typeof S.Tape>;

/**
 * The market's last fills as a booktabs table, Table `n` of the page (its
 * number depends on whether the viewer's positions come first). A sell is a
 * fill with negative shares; it is shown as a sell of their size.
 */
export function TapeTable({ market, tape, n }: { market: Market; tape: Tape; n: number }) {
  if (tape.orders.length === 0) return <div className={ui.empty}>No trades yet.</div>;
  const count = market.outcomes.length;
  return (
    <>
      <table className={ui.table}>
        <caption className={ui.tableCaption}>
          <b>Table {n}.</b> The last {tape.orders.length} {tape.orders.length === 1 ? 'fill' : 'fills'}, newest first.
        </caption>
        <thead>
          <tr>
            <th className={ui.th()}>Ago</th>
            <th className={ui.th()}>Side</th>
            <th className={ui.th(true)}>Shares</th>
            <th className={ui.th()}>Outcome</th>
            <th className={ui.th(true)}>
              Price<sup className={ui.mark}>a</sup>
            </th>
          </tr>
        </thead>
        <tbody className="font-mono text-[13px] whitespace-nowrap">
          {tape.orders.map((o) => {
            const sell = o.sharesMicro.startsWith('-');
            const i = market.outcomes.findIndex((x) => x.id === o.outcomeId);
            return (
              <tr key={o.id}>
                <td className={`${ui.td} text-subtle`} suppressHydrationWarning>
                  {ago(o.createdAt)}
                </td>
                <td className={`${ui.td} ${sell ? 'text-down' : 'text-up'}`}>{sell ? 'sell' : 'buy'}</td>
                <td className={`${ui.td} text-right`}>{shares(sell ? o.sharesMicro.slice(1) : o.sharesMicro, 2)}</td>
                <td className={ui.td}>
                  <OutcomeSwatch ordinal={i} outcomes={count} />
                  {market.outcomes[i]?.label ?? '?'}
                </td>
                <td className={`${ui.td} text-right`}>
                  <span className="text-muted">{pct(o.priceBefore, true)} →</span> {pct(o.priceAfter, true)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <TableNotes notes={[['a', 'The traded outcome’s price before and after the fill.']]} />
    </>
  );
}
