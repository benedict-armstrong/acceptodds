'use client';

import { useEffect, useState } from 'react';
import type { z } from 'zod';
import { sharesForCost } from '@/lib/lmsr';
import type * as S from '@/server/api/schemas';

type Quote = z.output<typeof S.Quote>;
type Market = z.output<typeof S.Market>;

/**
 * The shares `stakeMicro` buys of outcome `idx` on the board as given,
 * rounded down. The engine only takes a share count; quote it on the live
 * board, and send that quote, not the stake, as the order's bound.
 */
export function sharesForStake(market: Market, idx: number, stakeMicro: bigint): bigint {
  return BigInt(
    Math.floor(
      sharesForCost(
        market.outcomes.map((o) => Number(o.sharesMicro)),
        idx,
        Number(stakeMicro),
        market.b,
      ),
    ),
  );
}

/**
 * The engine's quote for trading `sharesMicro` (negative sells) of one
 * outcome, or `null` while there is none for exactly this order. Re-quoted,
 * debounced, whenever the order changes or `board` does: pass the polled
 * outcomes, which change on every poll, to keep the quote fresh.
 */
export function useQuote(marketId: string, outcomeId: string, sharesMicro: bigint | null, board: unknown): Quote | null {
  const [quote, setQuote] = useState<{ key: string; q: Quote } | null>(null);
  const key = `${outcomeId}:${sharesMicro}`;

  useEffect(() => {
    if (sharesMicro === null) return;
    const ctl = new AbortController();
    const t = setTimeout(async () => {
      const res = await fetch(`/api/v1/markets/${marketId}/quote`, {
        method: 'POST',
        credentials: 'omit',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ outcomeId, sharesMicro: sharesMicro.toString() }),
        signal: ctl.signal,
      }).catch(() => null);
      if (res?.ok) setQuote({ key, q: await res.json() });
    }, 200);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [key, board, marketId, outcomeId, sharesMicro]);

  return sharesMicro !== null && quote?.key === key ? quote.q : null;
}
