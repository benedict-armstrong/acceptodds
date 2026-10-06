'use client';

import { useState, type ComponentProps } from 'react';
import { TIER_FILL } from '@/lib/headline';
import { slotOf, TradeBox } from './TradeBox';

type Props = ComponentProps<typeof TradeBox> & {
  /** On a paper's page: "this paper", not "this". */
  paper?: boolean;
};

/**
 * The first bet on a market, which has no trades, chart or tape to go by:
 * first a question, "what do you think this will get?", and one button per outcome; then the stake for the outcome picked,
 * placed by the ordinary `TradeBox` with that outcome selected. Once there is a
 * fill the market is no longer new and the page uses `TradeBox` alone.
 */
export function FirstTrade({ paper = false, ...box }: Props) {
  const { market } = box;
  const [picked, setPicked] = useState<number | null>(null);
  const subject = paper ? 'this paper' : 'this';

  if (picked !== null) return <TradeBox {...box} initialIndex={picked} />;
  return (
    <div className="text-center">
      <h3 className="text-xl font-normal">What do you think {subject} will get?</h3>
      <p className="mt-1 mb-4 text-xs text-muted">All positions stay anonymous.</p>
      <div className="grid grid-cols-2 gap-2">
        {market.outcomes.map((o, i) => {
          // In its outcome's colour, as the trade box fills a selected outcome.
          const slot = slotOf(i, market.outcomes.length);
          const look = slot === null ? 'border-ink bg-ink text-white' : TIER_FILL[slot];
          return (
            <button
              key={o.id}
              type="button"
              className={`cursor-pointer border px-3 py-2 font-sans text-xl hover:opacity-85 ${look}`}
              onClick={() => setPicked(i)}
            >
              {o.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
