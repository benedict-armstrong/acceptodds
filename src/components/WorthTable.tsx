/** What the worth figures mean, as table notes. Liquidation value, never a mark (§1.1, §1.2). */
export const WORTH_NOTES = {
  netWorth: 'Cash plus the proceeds from selling all holdings now.',
  unrealized: 'Profit or loss on unsettled markets if sold now.',
  realized: 'Profit or loss on settled markets.',
} as const;
