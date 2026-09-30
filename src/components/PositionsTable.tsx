'use client';

import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import type { z } from 'zod';
import { OutcomeSwatch } from '@/components/OutcomeBar';
import { useOrder, type OrderResult } from '@/components/orders';
import { SellModal } from '@/components/SellModal';
import { ui } from '@/components/ui';
import { pct, rep, REP } from '@/lib/format';
import type * as S from '@/server/api/schemas';

type Holding = z.output<typeof S.Holding>;

/** Where a holding's market is read: its paper, with the market selected, or the market itself. */
export function holdingHref(h: Pick<Holding, 'marketSlug' | 'listingSlug'>): string {
  return h.listingSlug ? `/papers/${h.listingSlug}?market=${encodeURIComponent(h.marketSlug)}` : `/markets/${h.marketSlug}`;
}

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
      <table className={ui.table}>
        {caption && <caption className={ui.tableCaption}>{caption}</caption>}
        <thead>
          <tr>
            {showMarket && <th className={ui.th()}>Market</th>}
            <th className={ui.th()}>Outcome</th>
            <th className={ui.th(true)} title="The average price you paid per share">
              Bought @
            </th>
            <th className={ui.th(true)} title="What this pays if the outcome wins: one unit per share">
              Payout
            </th>
            <th className={ui.th(true)}>
              <button
                className="cursor-pointer font-semibold hover:text-accent"
                title={`What selling it all now would pay, against what it cost. Click for ${absolute ? 'percent' : REP}.`}
                onClick={() => setAbsolute((a) => !a)}
              >
                Current value ({absolute ? REP : '%'})
              </button>
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
          <Link href={holdingHref(h)}>{h.question}</Link>
          {h.marketStatus !== 'open' && <span className={ui.badge}>{h.marketStatus}</span>}
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
