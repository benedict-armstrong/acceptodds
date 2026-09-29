import { barOrder, MAX_BAR_OUTCOMES, paletteSlot, TIER_BG } from '@/lib/headline';

/**
 * A market's prices as one stacked bar, worst outcome on the left, in the
 * tier colours (`lib/headline.ts`): for a paper, reject · poster · spotlight
 * · oral. Prices, not values. Nothing for a market with more outcomes than the
 * palette has colours.
 */
export function OutcomeBar({
  prices,
  labels,
  className = 'h-1.5 w-16',
}: {
  /** Indexed by ordinal. */
  prices: readonly number[];
  /** Indexed by ordinal; given, each segment gets a hover title. */
  labels?: readonly string[];
  /** Size; the bar sets only its layout and colours. */
  className?: string;
}) {
  const n = prices.length;
  if (n < 2 || n > MAX_BAR_OUTCOMES) return null;
  return (
    <span className={`flex overflow-hidden rounded-[2px] ${className}`} aria-hidden>
      {barOrder(n).map((i) => (
        <span
          key={i}
          className={TIER_BG[paletteSlot(i, n)]}
          style={{ width: `${prices[i] * 100}%` }}
          title={labels ? `${labels[i]} ${Math.round(prices[i] * 100)}%` : undefined}
        />
      ))}
    </span>
  );
}
