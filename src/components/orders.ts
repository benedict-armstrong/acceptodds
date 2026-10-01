'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { rep, REP, shares } from '@/lib/format';

/** What the order endpoints' error codes mean, to a person. */
export const MESSAGES: Record<string, string> = {
  slippage_exceeded: 'The price moved before your order arrived. Check the new quote and try again.',
  insufficient_balance: 'Not enough reputation for this order.',
  insufficient_shares: 'You can only sell shares you hold.',
  not_verified: 'Only accounts with a confirmed institutional email can trade.',
  market_closed: 'This market has closed.',
  market_not_open: 'This market is not open.',
  unauthorized: 'Sign in to trade.',
  rate_limited: 'Too many requests. Wait a moment.',
};

/** Fired on `window` after an account's first order fills; `InvitePrompt` (mounted in the layout) listens. */
export const FIRST_TRADE_EVENT = 'acceptodds:first-trade';

export type OrderResult = { ok: boolean; text: string };

/**
 * Sends orders to one market: positive `sharesMicro` buys, negative sells —
 * one path, because selling is a trade with negative shares. Every order
 * carries the quote its sender showed as `maxCostMicro`, so it fills at the
 * shown price or better, or not at all (§6, §9).
 *
 * One `Idempotency-Key` per order: the same order retried after a network
 * error keeps it, so it cannot fill twice; any other order gets a new one.
 */
export function useOrder(marketId: string, onFilled: () => void) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<OrderResult | null>(null);
  const idempotencyKey = useRef<{ order: string; key: string } | null>(null);

  async function send(
    outcomeId: string,
    label: string,
    sharesMicro: string,
    maxCostMicro: string,
  ): Promise<OrderResult> {
    setBusy(true);
    setNote(null);
    const order = `${outcomeId}:${sharesMicro}:${maxCostMicro}`;
    if (idempotencyKey.current?.order !== order) idempotencyKey.current = { order, key: crypto.randomUUID() };
    let result: OrderResult;
    try {
      const res = await fetch(`/api/v1/markets/${marketId}/orders`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey.current.key },
        body: JSON.stringify({ outcomeId, sharesMicro, maxCostMicro }),
      });
      const body = await res.json();
      if (res.ok) {
        const c = BigInt(body.costMicro);
        const sell = sharesMicro.startsWith('-');
        result = {
          ok: true,
          text: sell
            ? `Sold ${shares(sharesMicro.slice(1))} ${label} for ${rep(-c)} ${REP}.`
            : `staked ${rep(c)} ${REP} on ${label}: pays ${rep(BigInt(sharesMicro))} ${REP} if it wins.`,
        };
        idempotencyKey.current = null;
        if (body.firstTrade) window.dispatchEvent(new Event(FIRST_TRADE_EVENT));
        onFilled();
        router.refresh(); // the balance in the header
      } else {
        result = { ok: false, text: MESSAGES[body.error?.code] ?? body.error?.message ?? 'Something went wrong.' };
        // A refused order is final; the next attempt is a new order.
        if (res.status !== 429) idempotencyKey.current = null;
      }
    } catch {
      result = { ok: false, text: 'Network error. Your order may or may not have gone through; check your trades.' };
    }
    setBusy(false);
    setNote(result);
    return result;
  }

  return { send, busy, note };
}
