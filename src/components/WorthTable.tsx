import type { ReactNode } from 'react';
import { Amount } from './Amount';
import { DetailsTable } from './DetailsTable';

/** What the worth figures mean, as table notes. Liquidation value, never a mark (§1.1, §1.2). */
export const WORTH_NOTES = {
  netWorth: 'Cash plus the proceeds from selling all holdings now.',
  unrealized: 'Profit or loss on unsettled markets if sold now.',
  realized: 'Profit or loss on settled markets.',
} as const;

/**
 * An account's cash, net worth and P&L as Table `n`: the portfolio's and the
 * profile's summary, from `getPortfolio().summary` or `valuation()`, which
 * share these fields.
 */
export function WorthTable({
  n,
  caption,
  worth,
}: {
  n: number;
  caption: ReactNode;
  worth: { cashMicro: bigint; netWorthMicro: bigint; unrealizedPnlMicro: bigint; realizedPnlMicro: bigint };
}) {
  return (
    <DetailsTable
      n={n}
      caption={caption}
      rows={[
        ['Cash', <Amount key="cash" micro={worth.cashMicro} />],
        ['Net worth', <Amount key="nw" micro={worth.netWorthMicro} />, 'a'],
        ['Unrealized P&L', <Amount key="u" micro={worth.unrealizedPnlMicro} signed />],
        ['Realized P&L', <Amount key="r" micro={worth.realizedPnlMicro} signed />],
      ]}
      notes={[['a', WORTH_NOTES.netWorth]]}
    />
  );
}
