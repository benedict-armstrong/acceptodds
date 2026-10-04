'use client';

import { useState, type ComponentProps } from 'react';
import { TradeBox } from './TradeBox';

type Props = ComponentProps<typeof TradeBox> & {
  /** On a paper's page: "this paper", not "this". */
  paper?: boolean;
};

/**
 * The first bet on a market, which has no trades, chart or tape to go by:
 * first a question, "what do you think this will get?", and one button per outcome; then the stake for the outcome picked,
 * placed by the ordinary `TradeBox` with that outcome fixed. Once there is a
 * fill the market is no longer new and the page uses `TradeBox` alone.
 */
export function FirstTrade({ paper = false, ...box }: Props) {
  const { market } = box;
  const [picked, setPicked] = useState<number | null>(null);
  const subject = paper ? 'this paper' : 'this';

  if (picked !== null) {
    return (
      <div>
        <button
          type="button"
          className="mb-2 -ml-1 cursor-pointer px-1 font-sans text-sm text-muted hover:text-ink"
          onClick={() => setPicked(null)}
        >
          ← Change outcome
        </button>
        <TradeBox {...box} lockedIndex={picked} />
      </div>
    );
  }
  return (
    <div className="text-center">
      <h3 className="text-xl font-normal">What do you think {subject} will get?</h3>
      <p className="mt-1 mb-4 text-xs text-muted">All positions stay anonymous.</p>
      <div className="grid grid-cols-2 gap-2">
        {market.outcomes.map((o, i) => (
          <button
            key={o.id}
            type="button"
            className="cursor-pointer border border-rule bg-white px-3 py-2 font-sans text-xl hover:border-ink hover:bg-tint"
            onClick={() => setPicked(i)}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}
