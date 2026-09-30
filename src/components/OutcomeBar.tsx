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

/**
 * The small square in an outcome's tier colour that stands for it in legends,
 * the tape and position lists. Nothing when the market has no bar.
 */
export function OutcomeSwatch({ ordinal, outcomes }: { ordinal: number; outcomes: number }) {
  if (ordinal < 0 || outcomes < 2 || outcomes > MAX_BAR_OUTCOMES) return null;
  return (
    <span
      className={`mr-1 inline-block size-2.5 rounded-[2px] align-[-1px] ${TIER_BG[paletteSlot(ordinal, outcomes)]}`}
      aria-hidden
    />
  );
}
