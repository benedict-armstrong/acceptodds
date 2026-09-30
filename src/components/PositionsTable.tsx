'use client';

import { useState, type ReactNode } from 'react';
import type { z } from 'zod';
import { OutcomeSwatch } from '@/components/OutcomeBar';
import { PaperName } from '@/components/PaperName';
import { useOrder, type OrderResult } from '@/components/orders';
import { SellModal } from '@/components/SellModal';
import { TableNotes } from '@/components/TableNotes';
import { ui } from '@/components/ui';
import { pct, rep, REP } from '@/lib/format';
import type * as S from '@/server/api/schemas';

type Holding = z.output<typeof S.Holding>;


/** Exit value minus cost basis: what selling it all now would gain or lose. */
function change(h: Holding): bigint {
  return BigInt(h.quotedExitMicro) - BigInt(h.costBasisMicro);
}

/** A change as `+5.0%` / `−5.0%`, or `+0.52 $rep` / `−0.52 $rep`: always signed, with a real minus. */
function formatChange(h: Holding, absolute: boolean): string {
  const c = change(h);
  const sign = c < 0n ? '−' : '+';
  const size = c < 0n ? -c : c;
  if (absolute) return `${sign}${rep(size)} ${REP}`;
  const basis = BigInt(h.costBasisMicro);
  return basis > 0n ? `${sign}${((Number(size) / Number(basis)) * 100).toFixed(1)}%` : '—';
}

/**
 * The viewer's open positions, one row per outcome held: the average price
 * paid (`Bought @`), the payout if that outcome wins (one unit per share),
 * and how the position stands now — what selling it all would pay against
 * what it cost, as a percentage or in `REP` (the header toggles). That
 * comparison is on the real exit quote, never the mark (§1.1), so right
 * after a buy it is honestly a little negative: the round trip's cost. Rows
 * the viewer can sell carry a `SellModal`.
 *
 * On a market's page (`MarketLive`) it lists that market's holdings; on
 * `/portfolio`, every holding, with `showMarket` adding the market column.
 */
export function PositionsTable({
  holdings,
  caption,
  showMarket = false,
  sellable,
  onFilled = () => {},
}: {
  holdings: Holding[];
  /** The table's paper-style caption, "<b>Table N.</b> …": the number depends on the page. */
  caption?: ReactNode;
  showMarket?: boolean;
  /** Ids of the markets whose holdings may be sold now: trading, and the viewer may trade. Plain data, so a Server Component can pass it. */
  sellable: string[];
  /** After a fill; `useOrder` already refreshes the server-rendered page. */
  onFilled?: () => void;
}) {
  const [absolute, setAbsolute] = useState(false);
  const [note, setNote] = useState<OrderResult | null>(null);
  const canSell = (h: Holding) => sellable.includes(h.marketId);
  const anySellable = holdings.some(canSell);

  return (
    <>
      <div className={ui.tableScroll}>
        <table className={ui.table}>
          {caption && (
            <caption className={ui.tableCaption}>{caption}</caption>
          )}
          <thead>
            <tr>
              {showMarket && <th className={ui.th()}>Paper</th>}
              <th className={ui.th()}>Outcome</th>
              <th className={`${ui.th(true)}`}>
                Bought @<sup className={ui.mark}>a</sup>
              </th>
              <th className={ui.th(true)}>
                Payout<sup className={ui.mark}>b</sup>
              </th>
              <th className={ui.th(true)}>
                <button
                  className="cursor-pointer font-semibold hover:text-accent"
                  title={`Show in ${absolute ? 'percent' : REP}`}
                  onClick={() => setAbsolute((a) => !a)}
                >
                  Current value ({absolute ? REP : '%'})
                </button>
                <sup className={ui.mark}>c</sup>
              </th>
              {anySellable && <th className={ui.th()} />}
            </tr>
          </thead>
          <tbody>
            {holdings.map((h) => (
              <Row
                key={h.outcomeId}
                h={h}
                showMarket={showMarket}
                sellable={canSell(h)}
                sellColumn={anySellable}
                absolute={absolute}
                onFilled={onFilled}
                onResult={setNote}
              />
            ))}
          </tbody>
        </table>
      </div>
      <TableNotes
        notes={[
          ['a', 'The average price you paid per share.'],
          ['b', <>What the holding pays if the outcome wins: 1 {REP} per share.</>],
          [
            'c',
            <>
              What selling it all now would pay, against what it cost. It starts a little negative, because each share
              you sell moves the price against you. Click the heading to switch between % and {REP}.
            </>,
          ],
        ]}
      />
      {note && <div className={ui.note(note.ok)}>{note.text}</div>}
    </>
  );
}

/** One holding. Its own `useOrder`, since on `/portfolio` each row may be a different market. */
function Row({
  h,
  showMarket,
  sellable,
  sellColumn,
  absolute,
  onFilled,
  onResult,
}: {
  h: Holding;
  showMarket: boolean;
  sellable: boolean;
  sellColumn: boolean;
  absolute: boolean;
  onFilled: () => void;
  onResult: (r: OrderResult) => void;
}) {
  const { send, busy } = useOrder(h.marketId, onFilled);
  return (
    <tr>
      {showMarket && (
        <td className={ui.td}>
          <PaperName m={h}>
            {h.marketStatus !== 'open' && <span className={`${ui.badge} shrink-0`}>{h.marketStatus}</span>}
          </PaperName>
        </td>
      )}
      <td className={`${ui.td} whitespace-nowrap`}>
        <OutcomeSwatch ordinal={h.outcomeOrdinal} outcomes={h.outcomeCount} />
        {h.outcomeLabel}
      </td>
      <td className={`${ui.td} ${ui.num}`}>{pct(Number(h.costBasisMicro) / Number(h.sharesMicro), true)}</td>
      <td className={`${ui.td} ${ui.num} whitespace-nowrap`}>
        {rep(h.sharesMicro)} {REP}
      </td>
      <td
        className={`${ui.td} ${ui.num} whitespace-nowrap ${ui.pnl(change(h))}`}
        title={`Selling it all now pays ${rep(h.quotedExitMicro)} ${REP}`}
      >
        {formatChange(h, absolute)}
      </td>
      {sellColumn && (
        <td className={`${ui.td} text-right`}>
          {sellable && (
            <SellModal
              marketId={h.marketId}
              board={h.price}
              holding={h}
              busy={busy}
              onSell={async (sharesMicro, maxCostMicro) => {
                const r = await send(h.outcomeId, h.outcomeLabel, sharesMicro, maxCostMicro);
                onResult(r);
                return r;
              }}
            />
          )}
        </td>
      )}
    </tr>
  );
}
