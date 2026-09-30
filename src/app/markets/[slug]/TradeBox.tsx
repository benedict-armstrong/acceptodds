'use client';

import { useState } from 'react';
import type { z } from 'zod';
import { SignInLink } from '@/components/AuthLinks';
import { ui } from '@/components/ui';
import { sharesForCost } from '@/lib/lmsr';
import { parseUnits } from '@/lib/money';
import { pct, rep, REP } from '@/lib/format';
import type * as S from '@/server/api/schemas';
import { MESSAGES, useOrder } from '@/components/orders';
import { useQuote } from '@/components/quote';

type Market = z.output<typeof S.Market>;

/** One button of a segmented control. */
function segment(on: boolean): string {
  return `flex-1 cursor-pointer border px-1 py-[5px] font-sans text-sm leading-[normal] ${on ? 'border-ink bg-ink text-white' : 'border-rule bg-white'}`;
}

/**
 * Buy any outcome by stake: the viewer names what to spend, never a share
 * count, and sees what it pays if that outcome wins. It only buys: selling
 * is from the viewer's positions (`Positions`), so there is nothing to pick
 * here that cannot be sold.
 * A signed-in viewer sees their cash at the top and what it would be after the
 * order; a buy they cannot afford is said so and not sent.
 *
 * What it shows is what the engine charges: the order is sent with the
 * quote it showed as `maxCostMicro` (`useOrder`).
 */
export function TradeBox({
  market,
  cashMicro,
  viewer,
  onFilled,
}: {
  market: Market;
  /** The viewer's cash, from their polled portfolio; `null` when signed out. */
  cashMicro: bigint | null;
  viewer: { signedIn: boolean; canTrade: boolean };
  onFilled: () => void;
}) {
  const [idx, setIdx] = useState(0);
  const [stake, setStake] = useState('10');
  const { send, busy, note } = useOrder(market.id, onFilled);

  const outcome = market.outcomes[idx];
  const budget = parseUnits(stake);
  // The shares the stake buys on the board as last polled, rounded down. The
  // engine only takes a share count; the quote then prices it on the live
  // board, and that quote, not the stake, is what is shown and bounds the order.
  const size =
    budget && budget > 0n
      ? BigInt(
        Math.floor(
          sharesForCost(
            market.outcomes.map((o) => Number(o.sharesMicro)),
            idx,
            Number(budget),
            market.b,
          ),
        ),
      )
      : null;
  const signed = size && size > 0n ? size : null;
  const current = useQuote(market.id, outcome.id, signed, market.outcomes);
  const cost = current ? BigInt(current.costMicro) : null;
  const cashAfter = cashMicro !== null && cost !== null ? cashMicro - cost : null;
  const short = cashAfter !== null && cashAfter < 0n;

  return (
    <div className={ui.box}>
      {cashMicro !== null && (
        <div className="mb-3 flex items-baseline justify-between border-b border-rule-soft pb-2">
          <span className={ui.label}>Your cash</span>
          <b className="font-mono text-lg">
            {rep(cashMicro)} {REP}
          </b>
        </div>
      )}
      <div className="mb-2 flex gap-1.5">
        {market.outcomes.map((o, i) => (
          <button key={o.id} className={segment(i === idx)} onClick={() => setIdx(i)}>
            {o.label} {pct(o.price)}
          </button>
        ))}
      </div>
      {/* A sentence, "Stake 10 $rep", whose number is an input sized to what
          is typed, marked only by a dashed underline (solid while hovered or
          focused). The whole line is the label, so a click anywhere on it
          lands in the input. */}
      <label className="mb-2 flex cursor-text items-baseline justify-center gap-2 text-2xl font-semibold text-muted">
        stake
        <input
          inputMode="decimal"
          value={stake}
          onChange={(e) => setStake(e.target.value)}
          placeholder="0"
          aria-label={`stake in ${REP}`}
          style={{ width: `${Math.max(stake.length, 1) + 2}ch` }}
          className="min-w-0 border-0 border-b-2 border-dashed border-rule-strong bg-transparent p-0 text-center font-mono text-4xl text-accent outline-none placeholder:text-faint hover:border-solid hover:border-accent focus:border-solid focus:border-accent"
        />
        <span className="font-mono">{REP}</span>
      </label>

      {cost !== null && current && (
        <>
          <div className={ui.kv}>
            <span>Pays if {outcome.label}</span>
            <b>
              {rep(BigInt(current.sharesMicro))} {REP}
            </b>
          </div>
          <div className={ui.kv}>
            <span>Price</span>
            <span>
              {pct(current.priceBefore, true)} → {pct(current.priceAfter, true)}
            </span>
          </div>
          {cashAfter !== null && (
            <div className={ui.kv}>
              <span>Cash after</span>
              <span className={short ? 'text-down' : ''}>
                {rep(cashAfter)} {REP}
              </span>
            </div>
          )}
        </>
      )}
      {short && (
        <div className={ui.note(false)}>
          Not enough cash: this costs {rep(cost!)} and you have {rep(cashMicro!)} {REP}.
        </div>
      )}

      {!viewer.signedIn ? (
        <SignInLink className={ui.btn()}>Sign in to trade</SignInLink>
      ) : !viewer.canTrade ? (
        <div className={ui.note(false)}>{MESSAGES.not_verified}</div>
      ) : (
        <button
          className={ui.btn()}
          disabled={!current || busy || short}
          onClick={() => current && signed !== null && send(outcome.id, outcome.label, signed.toString(), current.costMicro)}
        >
          {busy ? '…' : `Stake ${cost !== null ? rep(cost) : ''} ${REP} on ${outcome.label}`}
        </button>
      )}
      {cost !== null && <div className={ui.fine}>Refused if the price moves against you before it fills.</div>}
      {note && <div className={ui.note(note.ok)}>{note.text}</div>}
    </div>
  );
}
