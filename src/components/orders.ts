'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { rep, REP, shares } from '@/lib/format';
import { FIRST_TRADE_PATH } from '@/lib/links';
import { track } from '@/lib/track';

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

export type OrderResult = {
  ok: boolean;
  text: string;
  /** The account's first order ever (`Fill.firstTrade`). */
  firstTrade?: boolean;
  /** A refused order's error code. */
  code?: string;
};

/**
 * Sends orders to one market: positive `sharesMicro` buys, negative sells —
 * one path, because selling is a trade with negative shares. Every order
 * carries the quote its sender showed as `maxCostMicro`, so it fills at the
 * shown price or better, or not at all (§6, §9).
 *
 * An account's first fill goes to the first-trade page instead of
 * `onFilled`, unless `firstTradePage` is false: a caller with more to do
 * first (`Finish`) reads `firstTrade` on the result and goes there itself.
 *
 * One `Idempotency-Key` per order: the same order retried after a network
 * error keeps it, so it cannot fill twice; any other order gets a new one.
 */
export function useOrder(marketId: string, onFilled: () => void, { firstTradePage = true } = {}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<OrderResult | null>(null);
  const idempotencyKey = useRef<{ order: string; key: string } | null>(null);

  async function send(
    outcomeId: string,
    label: string,
    sharesMicro: string,
    maxCostMicro: string,
    /** A key of the caller's, for an order that must fill at most once whoever sends it (`Finish`). */
    key?: string,
  ): Promise<OrderResult> {
    setBusy(true);
    setNote(null);
    const order = `${outcomeId}:${sharesMicro}:${maxCostMicro}`;
    if (key) idempotencyKey.current = { order, key };
    else if (idempotencyKey.current?.order !== order) idempotencyKey.current = { order, key: crypto.randomUUID() };
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
          firstTrade: !!body.firstTrade,
          text: sell
            ? `Sold ${shares(sharesMicro.slice(1))} ${label} for ${rep(-c)} ${REP}.`
            : `staked ${rep(c)} ${REP} on ${label}: pays ${rep(BigInt(sharesMicro))} ${REP} if it wins.`,
        };
        idempotencyKey.current = null;
        track('order_placed', { side: sell ? 'sell' : 'buy', first: !!body.firstTrade });
        if (body.firstTrade && firstTradePage) {
          router.push(FIRST_TRADE_PATH);
        } else {
          onFilled();
          router.refresh(); // the balance in the header
        }
      } else {
        track('order_refused', { reason: String(body.error?.code ?? res.status) });
        result = {
          ok: false,
          code: body.error?.code,
          text: MESSAGES[body.error?.code] ?? body.error?.message ?? 'Something went wrong.',
        };
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
