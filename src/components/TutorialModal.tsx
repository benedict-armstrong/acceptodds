'use client';

import { useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Modal, ModalContent, ModalTrigger } from '@/components/Modal';
import { ui } from '@/components/ui';
import { pct, REP, rep, signedRep } from '@/lib/format';
import { MathText } from '@/components/MathText';
import { OutcomeBar } from '@/components/OutcomeBar';
import { costToTrade, sharesForCost } from '@/lib/lmsr';
import { costToMicro, microToFloat } from '@/lib/money';

type TutorialMarket = {
  title: string;
  href: string;
  b: number;
  outcomes: { label: string; price: number; sharesMicro: string }[];
};

const TITLES = ['What’s your prediction?', 'Try a small stake', 'See how it pays off'];

/** A local practice trade on a real market snapshot; never submits an order. */
export function TutorialModal({
  market,
  startingBalanceMicro,
}: {
  market: TutorialMarket | null;
  startingBalanceMicro: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState(0);
  const content = useRef<HTMLDivElement>(null);
  const [choice, setChoice] = useState(0);
  const [stakePercent, setStakePercent] = useState(1);
  const [wins, setWins] = useState(true);
  const outcome = market?.outcomes[choice];
  const stake = (BigInt(startingBalanceMicro) * BigInt(stakePercent)) / 100n;
  const q = market?.outcomes.map((o) => microToFloat(BigInt(o.sharesMicro))) ?? [];
  const payout = market && outcome ? BigInt(Math.floor(sharesForCost(q, choice, microToFloat(stake), market.b))) : 0n;
  const cost = market && outcome ? costToMicro(costToTrade(q, choice, microToFloat(payout), market.b)) : 0n;
  const href = market?.href ?? '/welcome';

  function advance() {
    if (!market || page === 2) {
      setOpen(false);
      router.push(href);
    } else {
      setPage((p) => Math.min(2, p + 1));
      content.current?.focus();
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={(value) => {
        setOpen(value);
        if (value) {
          setPage(0);
          setChoice(0);
          setStakePercent(1);
          setWins(true);
        }
      }}
    >
      <ModalTrigger type="button" className="cursor-pointer font-sans text-sm text-accent hover:underline">
        [about]
      </ModalTrigger>
      <ModalContent
        ref={content}
        title={market ? TITLES[page] : 'Find your first paper'}
        wide
        className="max-h-[calc(100dvh-32px)] overflow-y-auto"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          content.current?.focus();
        }}
        onKeyDown={(event) => {
          // Let controls keep their normal Space behaviour, especially inputs and buttons.
          if (
            event.key !== ' ' ||
            event.repeat ||
            event.altKey ||
            event.ctrlKey ||
            event.metaKey ||
            event.shiftKey ||
            !(event.target instanceof HTMLElement) ||
            event.target.closest('button, a, input, textarea, select, [contenteditable], [role="button"]')
          )
            return;
          event.preventDefault();
          advance();
        }}
      >
        {market && outcome ? (
          <>
            <p className="mb-3 text-xs text-muted">Practice only · free in-app {REP} · no real money</p>
            <div className="mb-4 border-b border-rule pb-3 font-serif text-base leading-snug">
              <MathText text={market.title} />
            </div>
            <div className="min-h-56">
              {page === 0 && (
                <>
                  <p className="mb-4 font-serif text-base">
                    The odds are the crowd’s prediction. Tap the outcome you’d back.
                  </p>
                  <OutcomeBar prices={market.outcomes.map((o) => o.price)} className="mb-4 h-3 w-full" />
                  <div className="grid grid-cols-2 gap-2 narrow:grid-cols-1">
                    {market.outcomes.map((o, i) => (
                      <button
                        key={i}
                        type="button"
                        onClick={() => {
                          setChoice(i);
                          advance();
                        }}
                        className="flex cursor-pointer items-center justify-between gap-3 border border-rule p-3 text-left hover:border-accent hover:bg-highlight"
                      >
                        <span>{o.label}</span>
                        <span className="font-mono text-lg text-accent">{pct(o.price)}</span>
                      </button>
                    ))}
                  </div>
                </>
              )}
              {page === 1 && (
                <>
                  <p className="mb-4 font-serif text-base">
                    Backing <b>{outcome.label}</b>. Move the slider to try a stake.
                  </p>
                  <label htmlFor="tutorial-stake" className="flex items-baseline justify-between gap-2">
                    Practice stake{' '}
                    <span className="font-mono text-lg">
                      {rep(stake)} {REP}
                    </span>
                  </label>
                  <input
                    id="tutorial-stake"
                    type="range"
                    min="1"
                    max="10"
                    step="1"
                    value={stakePercent}
                    onChange={(event) => setStakePercent(Number(event.target.value))}
                    className="my-4 w-full cursor-pointer accent-accent"
                  />
                  <div className="flex items-center justify-between gap-3 border-y border-rule py-4">
                    <span>If {outcome.label} wins</span>
                    <span aria-live="polite" className="font-mono text-2xl text-accent">
                      {rep(payout)} {REP}
                    </span>
                  </div>
                  <p className="mt-2 text-xs text-muted">
                    Estimated payout at these odds. Your real trade shows a fresh quote.
                  </p>
                  <button type="button" className={ui.btn()} onClick={advance}>
                    Try this practice trade
                  </button>
                </>
              )}
              {page === 2 && (
                <>
                  <p className="mb-4 font-serif text-base">Try both results for your prediction.</p>
                  <div className="flex flex-wrap gap-2">
                    {[true, false].map((result) => (
                      <button
                        key={String(result)}
                        type="button"
                        aria-pressed={wins === result}
                        className={ui.btn({ ghost: wins !== result, inline: true, flush: true })}
                        onClick={() => setWins(result)}
                      >
                        {outcome.label} {result ? 'wins' : 'loses'}
                      </button>
                    ))}
                  </div>
                  <div aria-live="polite" className="my-5 border-y border-rule py-4">
                    <div className={ui.kv}>
                      <span>Practice cost</span>
                      <span className="font-mono">
                        {rep(cost)} {REP}
                      </span>
                    </div>
                    <div className={`mt-2 ${ui.kv}`}>
                      <span>Payout</span>
                      <span className="font-mono">
                        {rep(wins ? payout : 0n)} {REP}
                      </span>
                    </div>
                    <div className={`mt-3 ${ui.kv}`}>
                      <span>Profit / loss</span>
                      <span className={`font-mono text-2xl ${ui.pnl((wins ? payout : 0n) - cost)}`}>
                        {signedRep((wins ? payout : 0n) - cost)} {REP}
                      </span>
                    </div>
                  </div>
                  <p className="font-serif text-base">
                    Your turn. Open the paper and back your judgement with a small stake.
                  </p>
                </>
              )}
            </div>
          </>
        ) : (
          <p className="py-6 font-serif text-base">
            Pick a paper, choose an outcome, and try a small stake with free {REP}.
          </p>
        )}
        <div className="mt-4 flex items-center justify-between gap-3 border-t border-rule pt-3">
          <button
            type="button"
            className={ui.btn({ ghost: true, inline: true, flush: true })}
            disabled={page === 0}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
          >
            Back
          </button>
          <span aria-live="polite" aria-atomic="true" className="font-mono text-xs text-muted">
            {page + 1} / {market ? TITLES.length : 1}
          </span>
          {page === 2 || !market ? (
            <Link href={href} className={ui.btn({ inline: true, flush: true })} onClick={() => setOpen(false)}>
              {market ? 'Trade on this paper' : 'Choose a paper'}
            </Link>
          ) : (
            <button type="button" className={ui.btn({ inline: true, flush: true })} onClick={advance}>
              Next
            </button>
          )}
        </div>
      </ModalContent>
    </Modal>
  );
}
