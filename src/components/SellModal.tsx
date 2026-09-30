'use client';

import { useState } from 'react';
import type { z } from 'zod';
import { Modal, ModalContent, ModalTrigger } from '@/components/Modal';
import { ui } from '@/components/ui';
import { pct, rep, REP, shares } from '@/lib/format';
import { parseUnits } from '@/lib/money';
import type * as S from '@/server/api/schemas';
import { useQuote } from '@/components/quote';

type Holding = z.output<typeof S.Holding>;

const PRESETS = [10, 50, 100] as const;

/** One button of the preset row. */
function preset(on: boolean): string {
  return `flex-1 cursor-pointer border px-1 py-[5px] font-mono text-[13px] leading-[normal] ${on ? 'border-ink bg-ink text-white' : 'border-rule bg-white'}`;
}

/**
 * Sell some or all of one holding: 10, 50 or 100% of it, or a custom number
 * of shares, never more than is held. The amount is quoted live and the order
 * is sent with that quote as its bound, like a buy (§9).
 */
export function SellModal({
  marketId,
  board,
  holding,
  busy,
  onSell,
}: {
  marketId: string;
  /** The polled outcomes: re-quotes on every poll. */
  board: unknown;
  holding: Holding;
  busy: boolean;
  /** Sends the sell; resolves to the outcome, to close on success or show why not. */
  onSell: (sharesMicro: string, maxCostMicro: string) => Promise<{ ok: boolean; text: string }>;
}) {
  const [open, setOpen] = useState(false);
  const [pick, setPick] = useState<number | 'custom'>(100);
  const [custom, setCustom] = useState('');
  const [error, setError] = useState<string | null>(null);

  const held = BigInt(holding.sharesMicro);
  const amount = pick === 'custom' ? parseUnits(custom) : pick === 100 ? held : (held * BigInt(pick)) / 100n;
  const tooMany = amount !== null && amount > held;
  const size = amount !== null && amount > 0n && !tooMany ? amount : null;
  const quote = useQuote(marketId, holding.outcomeId, open && size !== null ? -size : null, board);
  const proceeds = quote ? -BigInt(quote.costMicro) : null;

  async function sell() {
    if (!quote || size === null) return;
    setError(null);
    const r = await onSell((-size).toString(), quote.costMicro);
    if (r.ok) setOpen(false);
    else setError(r.text);
  }

  return (
    <Modal
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        setError(null);
      }}
    >
      <ModalTrigger className={ui.btn({ inline: true, flush: true })}>Sell</ModalTrigger>
      <ModalContent title={`Sell ${holding.outcomeLabel}`}>
        <div className={`mb-2 ${ui.kv}`}>
          <span>You hold</span>
          <span className="font-mono">{shares(held)}</span>
        </div>
        <div className="mb-2 flex gap-1.5">
          {PRESETS.map((p) => (
            <button key={p} className={preset(pick === p)} onClick={() => setPick(p)}>
              {p}%
            </button>
          ))}
          <button className={preset(pick === 'custom')} onClick={() => setPick('custom')}>
            custom
          </button>
        </div>
        {pick === 'custom' && (
          <input
            autoFocus
            inputMode="decimal"
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            aria-label="shares to sell"
            placeholder={`shares, up to ${shares(held)}`}
            className={ui.input}
          />
        )}
        {tooMany && <div className={ui.note(false)}>You hold only {shares(held)}.</div>}

        {size !== null && (
          <>
            <div className={ui.kv}>
              <span>Shares</span>
              <span className="font-mono">{shares(size)}</span>
            </div>
            <div className={ui.kv}>
              <span>You receive</span>
              <b>{proceeds !== null ? `${rep(proceeds)} ${REP}` : '…'}</b>
            </div>
            {quote && (
              <div className={ui.kv}>
                <span>Price</span>
                <span>
                  {pct(quote.priceBefore, true)} → {pct(quote.priceAfter, true)}
                </span>
              </div>
            )}
          </>
        )}

        <button className={ui.btn()} disabled={!quote || size === null || busy} onClick={sell}>
          {busy ? '…' : size !== null ? `Sell ${shares(size)} ${holding.outcomeLabel}` : 'Sell'}
        </button>
        {proceeds !== null && <div className={ui.fine}>Refused if the proceeds fall below {rep(proceeds)}.</div>}
        {error && <div className={ui.note(false)}>{error}</div>}
      </ModalContent>
    </Modal>
  );
}
