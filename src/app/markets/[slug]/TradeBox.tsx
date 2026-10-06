'use client';

import { useState } from 'react';
import type { z } from 'zod';
import { SignInLink } from '@/components/AuthLinks';
import { ui } from '@/components/ui';
import { MAX_BAR_OUTCOMES, paletteSlot, TIER_FILL, TIER_STRONG_BG } from '@/lib/headline';
import { parseUnits } from '@/lib/money';
import { payoutReturn, pct, rep, REP } from '@/lib/format';
import type * as S from '@/server/api/schemas';
import { MESSAGES, useOrder } from '@/components/orders';
import { sharesForStake, useQuote } from '@/components/quote';

type Market = z.output<typeof S.Market>;

/** An outcome and a stake, and the market's `orderCount` on the board they were chosen from. */
export interface Choice {
  outcomeId: string;
  stakeMicro: bigint;
  seenOrderCount: number;
}

/**
 * The palette slot of outcome `i` of `n`, as the outcome bar colours it (red/green
 * for two); `null` past `MAX_BAR_OUTCOMES`, which the bar leaves uncoloured too.
 */
export function slotOf(i: number, n: number): number | null {
  return n <= MAX_BAR_OUTCOMES ? paletteSlot(i, n) : null;
}

/** One button of a segmented control: the selected one filled, in its outcome's colour when it has one. */
export function segment(on: boolean, slot: number | null): string {
  const look = !on ? 'border-rule bg-white' : slot === null ? 'border-ink bg-ink text-white' : TIER_FILL[slot];
  return `flex-1 cursor-pointer border px-1 py-[5px] font-sans text-sm leading-[normal] ${look}`;
}

/**
 * Buy any outcome by stake: the viewer names what to spend, never a share
 * count, and sees what it pays if that outcome wins. It only buys: selling
 * is from the viewer's positions (`Positions`), so there is nothing to pick
 * here that cannot be sold.
 * A signed-in viewer sees their cash under the stake; a buy they cannot
 * afford is said so and not sent.
 *
 * What it shows is what the engine charges: the order is sent with the
 * quote it showed as `maxCostMicro` (`useOrder`).
 *
 * With `onChoose`, it sends nothing: its button hands the choice back, for a
 * visitor who has no account yet — in onboarding (`/welcome`), or on a
 * market's page, which then opens onboarding at the step after the bet.
 * `cashMicro` is then the balance they will start with.
 */
export function TradeBox({
  market,
  cashMicro,
  viewer,
  onFilled,
  onChoose,
  initialIndex = 0,
}: {
  market: Market;
  /** The viewer's cash, from their polled portfolio; `null` when signed out. */
  cashMicro: bigint | null;
  viewer: { signedIn: boolean; canTrade: boolean };
  /** After a fill: the outcome bought and the stake entered. */
  onFilled: (choice: Choice) => void;
  /** Instead of placing the order: the outcome and the stake. */
  onChoose?: (choice: Choice) => void;
  /** The outcome selected at first (`FirstTrade`'s pick). */
  initialIndex?: number;
}) {
  const [idx, setIdx] = useState(initialIndex);
  const [stake, setStake] = useState('100');
  const outcome = market.outcomes[idx];
  const slot = slotOf(idx, market.outcomes.length);
  const buy = ui.btn({ fill: slot === null ? '' : TIER_STRONG_BG[slot] });
  const budget = parseUnits(stake);
  // Called after the fill, with this render's choice: the one the order was sent from.
  const { send, busy, note } = useOrder(market.id, () =>
    onFilled({ outcomeId: outcome.id, stakeMicro: budget ?? 0n, seenOrderCount: market.orderCount }),
  );
  // The shares the stake buys on the board as last polled, rounded down. The
  // engine only takes a share count; the quote then prices it on the live
  // board, and that quote, not the stake, is what is shown and bounds the order.
  const size = budget && budget > 0n ? sharesForStake(market, idx, budget) : null;
  const signed = size && size > 0n ? size : null;
  const current = useQuote(market.id, outcome.id, signed, market.outcomes);
  const cost = current ? BigInt(current.costMicro) : null;
  const short = cashMicro !== null && cost !== null && cost > cashMicro;
  const payoutRet = current && cost !== null ? payoutReturn(BigInt(current.sharesMicro), cost) : null;

  return (
    <div className={ui.box}>
      {/* Four outcomes don't fit in one row on a phone: two by two there. `data-outcomes`: where "Place a bet" scrolls. */}
      <div
        data-outcomes
        className={`mb-2 flex gap-1.5 ${market.outcomes.length > 2 ? 'narrow:grid narrow:grid-cols-2' : ''}`}
      >
        {market.outcomes.map((o, i) => (
          <button
            key={o.id}
            aria-pressed={i === idx}
            className={segment(i === idx, slotOf(i, market.outcomes.length))}
            onClick={() => setIdx(i)}
          >
            {o.label} {pct(o.price)}
          </button>
        ))}
      </div>
      {/* A sentence, "Stake 10 $rep", whose number is an input sized to what
          is typed, marked only by a dashed underline (solid while hovered or
          focused). The whole line is the label, so a click anywhere on it
          lands in the input. The balance under it is justified to the same
          width: the wrapper is as wide as the wider of the two. */}
      <div className="mx-auto mb-4 w-fit">
        <label className="flex cursor-text items-baseline justify-center gap-2 text-2xl font-semibold text-muted">
          stake
          <input
            inputMode="decimal"
            value={stake}
            onChange={(e) => setStake(e.target.value)}
            placeholder="0"
            aria-label={`stake in ${REP}`}
            style={{ width: `${Math.max(stake.length, 1) + 1}ch` }}
            className="min-w-0 border-0 border-b-2 border-dashed border-rule-strong bg-transparent p-0 text-center font-mono text-4xl text-accent outline-none placeholder:text-faint hover:border-solid hover:border-accent focus:border-solid focus:border-accent"
          />
          <span className="font-mono">{REP}</span>
        </label>
        {cashMicro !== null && (
          <div
            className={`mt-3 text-justify font-bold text-sm [text-align-last:justify] ${short ? 'text-down' : 'text-faint'}`}
          >
            out of{' '}
            <span className="font-mono">
              {rep(cashMicro)} {REP}
            </span>{' '}
            balance
          </div>
        )}
      </div>

      {cost !== null && current && (
        <>
          <div className={ui.kv}>
            <span>Payout if {outcome.label}</span>
            <b>
              {rep(BigInt(current.sharesMicro))} {REP}
              {payoutRet && <span className="ml-1.5 font-normal text-muted">({payoutRet})</span>}
            </b>
          </div>
          <div className={ui.kv}>
            <span>Price</span>
            <span>
              {pct(current.priceBefore, true)} → {pct(current.priceAfter, true)}
            </span>
          </div>
        </>
      )}
      {short && (
        <div className={ui.note(false)}>
          Not enough cash: this costs {rep(cost!)} and you have {rep(cashMicro!)} {REP}.
        </div>
      )}

      {onChoose ? (
        <>
          <button
            className={buy}
            disabled={budget === null || budget <= 0n || short}
            onClick={() =>
              budget && onChoose({ outcomeId: outcome.id, stakeMicro: budget, seenOrderCount: market.orderCount })
            }
          >
            Stake {budget ? rep(budget) : ''} {REP} on {outcome.label}
          </button>
        </>
      ) : !viewer.signedIn ? (
        <SignInLink className={ui.btn()}>Sign in to trade</SignInLink>
      ) : !viewer.canTrade ? (
        <div className={ui.note(false)}>{MESSAGES.not_verified}</div>
      ) : (
        <button
          className={buy}
          disabled={!current || busy || short}
          onClick={() =>
            current && signed !== null && send(outcome.id, outcome.label, signed.toString(), current.costMicro)
          }
        >
          {busy ? '…' : `Stake ${cost !== null ? rep(cost) : ''} ${REP} on ${outcome.label}`}
        </button>
      )}
      {cost !== null && !onChoose && (
        <div className={ui.fine}>Refused if the price moves against you before it fills.</div>
      )}
      {note && <div className={ui.note(note.ok)}>{note.text}</div>}
    </div>
  );
}
