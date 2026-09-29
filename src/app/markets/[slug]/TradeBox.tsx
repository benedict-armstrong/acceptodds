'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import type { z } from 'zod';
import { parseUnits } from '@/lib/money';
import { pct, rep, shares } from '@/lib/format';
import type * as S from '@/server/api/schemas';

type Market = z.output<typeof S.Market>;
type Holding = z.output<typeof S.Holding>;
type Quote = z.output<typeof S.Quote>;

const MESSAGES: Record<string, string> = {
  slippage_exceeded: 'The price moved before your order arrived. Check the new quote and try again.',
  insufficient_balance: 'Not enough reputation for this order.',
  insufficient_shares: 'You can only sell shares you hold.',
  not_verified: 'Only accounts with a confirmed institutional email can trade.',
  market_closed: 'This market has closed.',
  market_not_open: 'This market is not open.',
  unauthorized: 'Sign in to trade.',
  rate_limited: 'Too many requests. Wait a moment.',
};

/**
 * Buy or sell — one widget, because selling is a trade with negative shares.
 *
 * What it shows is what the engine charges: the quote prices the **whole**
 * order, and the order is sent with that quote as `maxCostMicro`, so it fills
 * at the shown cost or better, or not at all (§6, §9).
 */
export function TradeBox({
  market,
  holdings,
  viewer,
  onFilled,
}: {
  market: Market;
  holdings: Holding[];
  viewer: { signedIn: boolean; canTrade: boolean };
  onFilled: () => void;
}) {
  const router = useRouter();
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [idx, setIdx] = useState(0);
  const [amount, setAmount] = useState('10');
  const [quote, setQuote] = useState<{ key: string; q: Quote } | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const idempotencyKey = useRef<string | null>(null);

  const outcome = market.outcomes[idx];
  const held = holdings.find((h) => h.outcomeId === outcome.id);
  const size = parseUnits(amount);
  const signed = size && size > 0n ? (side === 'buy' ? size : -size) : null;
  const key = `${outcome.id}:${signed}`;

  // A different order is a different idempotency key. The same order retried
  // after a network error keeps its key, so it cannot fill twice.
  useEffect(() => {
    idempotencyKey.current = null;
  }, [key]);

  // Re-quote whenever the order or the board changes.
  useEffect(() => {
    if (signed === null) {
      setQuote(null);
      return;
    }
    const ctl = new AbortController();
    const t = setTimeout(async () => {
      const res = await fetch(`/api/v1/markets/${market.id}/quote`, {
        method: 'POST',
        credentials: 'omit',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ outcomeId: outcome.id, sharesMicro: signed.toString() }),
        signal: ctl.signal,
      }).catch(() => null);
      if (res?.ok) setQuote({ key, q: await res.json() });
    }, 200);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
    // market.outcomes changes on every poll, which is what keeps the quote fresh.
  }, [key, market.outcomes, market.id, outcome.id, signed]);

  const current = quote?.key === key ? quote.q : null;
  const cost = current ? BigInt(current.costMicro) : null;

  async function submit() {
    if (!current || signed === null) return;
    setBusy(true);
    setNote(null);
    idempotencyKey.current ??= crypto.randomUUID();
    try {
      const res = await fetch(`/api/v1/markets/${market.id}/orders`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey.current },
        body: JSON.stringify({ outcomeId: outcome.id, sharesMicro: signed.toString(), maxCostMicro: current.costMicro }),
      });
      const body = await res.json();
      if (res.ok) {
        const c = BigInt(body.costMicro);
        setNote({
          ok: true,
          text:
            side === 'buy'
              ? `Bought ${shares(size!)} ${outcome.label} for ${rep(c)} rep.`
              : `Sold ${shares(size!)} ${outcome.label} for ${rep(-c)} rep.`,
        });
        idempotencyKey.current = null;
        onFilled();
        router.refresh(); // the balance in the header
      } else {
        setNote({ ok: false, text: MESSAGES[body.error?.code] ?? body.error?.message ?? 'Something went wrong.' });
        // A refused order is final; the next attempt is a new order.
        if (res.status !== 429) idempotencyKey.current = null;
      }
    } catch {
      setNote({ ok: false, text: 'Network error. Your order may or may not have gone through; check your trades.' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="box">
      <div className="seg">
        <button className={side === 'buy' ? 'on' : ''} onClick={() => setSide('buy')}>
          Buy
        </button>
        <button className={side === 'sell' ? 'on' : ''} onClick={() => setSide('sell')}>
          Sell
        </button>
      </div>
      <div className="seg">
        {market.outcomes.map((o, i) => (
          <button key={o.id} className={i === idx ? 'on' : ''} onClick={() => setIdx(i)}>
            {o.label} {pct(o.price)}
          </button>
        ))}
      </div>
      <input
        inputMode="decimal"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        aria-label="shares"
        placeholder="shares"
      />

      {cost !== null && current && (
        <>
          <div className="kv">
            <span>{side === 'buy' ? 'Cost' : 'You receive'}</span>
            <b>{rep(side === 'buy' ? cost : -cost)} rep</b>
          </div>
          <div className="kv">
            <span>Price</span>
            <span>
              {pct(current.priceBefore, true)} → {pct(current.priceAfter, true)}
            </span>
          </div>
          {side === 'buy' && (
            <div className="kv">
              <span>Pays if {outcome.label}</span>
              <span>{shares(size!)} rep</span>
            </div>
          )}
        </>
      )}

      {!viewer.signedIn ? (
        <Link href="/signin" className="btn" style={{ textDecoration: 'none' }}>
          Sign in to trade
        </Link>
      ) : !viewer.canTrade ? (
        <div className="note err">{MESSAGES.not_verified}</div>
      ) : (
        <button className="btn" disabled={!current || busy} onClick={submit}>
          {busy ? '…' : `${side === 'buy' ? 'Buy' : 'Sell'} ${size ? shares(size) : ''} ${outcome.label}`}
        </button>
      )}
      {cost !== null && (
        <div className="fine">
          {side === 'buy'
            ? `Refused if the cost rises above ${rep(cost)}.`
            : `Refused if the proceeds fall below ${rep(-cost)}.`}
        </div>
      )}
      {note && <div className={`note ${note.ok ? 'ok' : 'err'}`}>{note.text}</div>}

      {holdings.length > 0 && <hr className="thin" />}
      {holdings.map((h) => (
        <div key={h.outcomeId} style={{ marginBottom: 8 }}>
          <div className="kv">
            <span>
              You hold {shares(h.sharesMicro)} {h.outcomeLabel} · marked
            </span>
            <span>{rep(h.markMicro)}</span>
          </div>
          <div className="kv">
            <span>Sell all now</span>
            <b>{rep(h.quotedExitMicro)}</b>
          </div>
          <button
            className="btn ghost"
            onClick={() => {
              setSide('sell');
              setIdx(market.outcomes.findIndex((o) => o.id === h.outcomeId));
              setAmount(shares(h.sharesMicro).replace(/,/g, ''));
            }}
          >
            Sell {shares(h.sharesMicro)} {h.outcomeLabel}
          </button>
        </div>
      ))}
      {held === undefined && side === 'sell' && viewer.signedIn && (
        <div className="fine">You hold no {outcome.label}.</div>
      )}
    </div>
  );
}
