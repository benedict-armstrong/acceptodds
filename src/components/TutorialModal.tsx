'use client';

import { useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import type { z } from 'zod';
import { Confetti } from '@/components/Confetti';
import { MathText } from '@/components/MathText';
import { Modal, ModalClose, ModalTitle, ModalTrigger, SheetContent } from '@/components/Modal';
import { sharesForStake } from '@/components/quote';
import { ui } from '@/components/ui';
import { pct, rep, REP } from '@/lib/format';
import { marketHeadline } from '@/lib/headline';
import { LIKELIHOOD_CLASS, likelihood } from '@/lib/likelihood';
import { unitsToMicro } from '@/lib/money';
import type * as S from '@/server/api/schemas';

type Listing = z.output<typeof S.Listing>;

const STEP_TITLE = 'font-serif text-2xl font-normal';

/** Hanson (2007), the market maker's source; `/how-it-works` cites it too. */
const LMSR_PAPER = 'https://mason.gmu.edu/~rhanson/mktscore.pdf';

/** The stake the illustrations price. Only the stake is an example: what it pays is the market's own quote. */
const EXAMPLE_STAKE = unitsToMicro(100);

/** The example market, read for the illustrations: its two ends and what the example stake pays on each. */
type Example = {
  title: string;
  accept: number;
  sides: { label: string; payoutMicro: bigint }[];
};

function exampleOf(listing?: Listing): Example | null {
  const market = listing?.markets[0];
  const accept = market ? marketHeadline(market) : null;
  if (!listing || !market || accept === null || market.status !== 'open') return null;
  // Outcomes run best first, worst last (`lib/headline.ts`): for a paper, Accept and Reject.
  const byOrdinal = market.outcomes.map((o, i) => ({ o, i })).sort((a, b) => a.o.ordinal - b.o.ordinal);
  const ends = [byOrdinal[0], byOrdinal[byOrdinal.length - 1]];
  return {
    title: listing.title,
    accept,
    // Each share pays 1 if its outcome happens, so the shares bought are the payout.
    sides: ends.map(({ o, i }) => ({ label: o.label, payoutMicro: sharesForStake(market, i, EXAMPLE_STAKE) })),
  };
}

/**
 * The tutorial behind [about], after Polymarket's: three steps, each an
 * illustration, a numbered heading, a paragraph and one button. A modal on a
 * wide screen, a bottom sheet on a phone. The illustrations are drawn from one
 * real open market; without one, the steps are text alone.
 */
export function TutorialModal({
  example: listing,
  startingBalanceMicro,
  signedIn,
}: {
  example?: Listing;
  startingBalanceMicro: string;
  signedIn: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(0);
  const content = useRef<HTMLDivElement>(null);
  const example = exampleOf(listing);
  const [yes, no] = example?.sides.map((s) => s.label) ?? ['Accept', 'Reject'];

  const steps: { title: string; art: ReactNode; body: ReactNode; fine?: ReactNode }[] = [
    {
      title: 'Pick a paper',
      art: example && <PaperCard example={example} />,
      body: (
        <>
          Buy ‘{yes}’ or ‘{no}’ depending on your prediction. Odds shift in real time as other traders weigh in.
        </>
      ),
      fine: (
        <>
          Odds are set by Hanson’s logarithmic market scoring rule: see{' '}
          <Link href="/how-it-works#maker">How it works</Link>, or{' '}
          <a href={LMSR_PAPER} target="_blank" rel="noopener noreferrer">
            the paper
          </a>
          .
        </>
      ),
    },
    {
      title: 'Place a trade',
      art: example && <StakeCards example={example} />,
      body: (
        <>
          {signedIn ? 'Every account starts with' : 'Sign up with your institutional email and get'}{' '}
          <span className="font-mono text-ink">
            {rep(startingBalanceMicro, 0)} {REP}
          </span>
          {signedIn ? '. Choose a side and a stake, and you’re trading.' : '—then you’re ready to trade.'}
        </>
      ),
    },
    {
      title: 'Cash out',
      art: example && <Receipt example={example} />,
      body: (
        <>
          Sell your shares at any time, or wait until the decision to redeem each winning share for 1 {REP}.{' '}
          {signedIn
            ? 'Pick a paper and place your first trade.'
            : 'Create an account and place your first trade in minutes.'}
        </>
      ),
      fine: <>{REP} is play money, with no cash value. Trading needs an email at a research institution.</>,
    },
  ];
  const last = steps.length - 1;
  const current = steps[step];

  function go(next: number) {
    setStep(next);
    content.current?.scrollTo({ top: 0 });
  }

  return (
    <Modal
      open={open}
      onOpenChange={(value) => {
        setOpen(value);
        if (value) setStep(0);
      }}
    >
      <ModalTrigger type="button" className={`font-sans text-sm ${ui.linkBtn}`}>
        [about]
      </ModalTrigger>
      <SheetContent
        ref={content}
        onDismiss={() => setOpen(false)}
        onKeyDown={(event) => {
          if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
          if (event.key === 'ArrowRight' && step < last) go(step + 1);
          else if (event.key === 'ArrowLeft' && step > 0) go(step - 1);
        }}
      >
        {current.art && (
          // Faded towards the top, as if the illustration rose out of the page.
          <div
            className="relative flex h-60 items-center justify-center [mask-image:linear-gradient(to_top,black_45%,transparent)]"
            aria-hidden="true"
          >
            {current.art}
          </div>
        )}
        {step === last && example && <Confetti />}
        {/* Every step's text in one grid cell, the others invisible, so the sheet is as tall as the longest and
            never changes size between steps. */}
        <div className="mt-4 grid">
          {steps.map((s, i) => (
            <div key={s.title} className={`[grid-area:1/1] ${i === step ? '' : 'invisible'}`} aria-hidden={i !== step}>
              {i === step ? (
                <ModalTitle className={STEP_TITLE}>
                  {i + 1}. {s.title}
                </ModalTitle>
              ) : (
                <p className={STEP_TITLE}>
                  {i + 1}. {s.title}
                </p>
              )}
              <p className="mt-3 font-serif text-base leading-relaxed text-subtle">{s.body}</p>
              {s.fine && <p className="mt-4 text-xs text-muted">{s.fine}</p>}
            </div>
          ))}
        </div>
        <div className="mt-6">
          {step < last ? (
            <button type="button" className={ui.btn()} onClick={() => go(step + 1)}>
              Next
            </button>
          ) : signedIn ? (
            <ModalClose className={ui.btn()}>Start trading</ModalClose>
          ) : (
            <Link href="/welcome" className={ui.btn()} onClick={() => setOpen(false)}>
              Get started
            </Link>
          )}
        </div>
      </SheetContent>
    </Modal>
  );
}

/** The paper as a card: title, odds and its two sides, tilted a little. */
function PaperCard({ example }: { example: Example }) {
  const [yes, no] = example.sides;
  return (
    <div className="w-72 -rotate-3 border border-frame bg-card p-4 shadow-lg">
      <div className="flex items-start justify-between gap-3">
        <span className="line-clamp-2 font-serif text-sm leading-snug">
          <MathText text={example.title} />
        </span>
        <span className={`shrink-0 font-mono text-lg ${LIKELIHOOD_CLASS[likelihood(example.accept)].text}`}>
          {pct(example.accept)}
        </span>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-2 text-center text-sm font-semibold">
        <span className={`py-1.5 text-white ${LIKELIHOOD_CLASS.accept.bar}`}>{yes.label}</span>
        <span className="bg-rule-soft py-1.5 text-subtle">{no.label}</span>
      </div>
    </div>
  );
}

/** The example stake on each side, with what the market would pay for it now. */
function StakeCards({ example }: { example: Example }) {
  const [yes, no] = example.sides;
  return (
    <>
      <div className="absolute translate-x-12 -translate-y-8 rotate-6">
        <StakeCard side={no} tone={LIKELIHOOD_CLASS.reject.bar} />
      </div>
      <div className="absolute -translate-x-10 translate-y-6 -rotate-3">
        <StakeCard side={yes} tone={LIKELIHOOD_CLASS.accept.bar} />
      </div>
    </>
  );
}

function StakeCard({ side, tone }: { side: Example['sides'][number]; tone: string }) {
  return (
    <div className="w-52 border border-frame bg-card p-4 text-center shadow-lg">
      <div className="flex items-center justify-between">
        <span className="bg-rule-soft px-2 text-muted">−</span>
        <span className="font-mono text-2xl text-ink">
          {rep(EXAMPLE_STAKE, 0)} <span className="text-sm">{REP}</span>
        </span>
        <span className="bg-rule-soft px-2 text-muted">+</span>
      </div>
      <div className="mt-1 text-xs text-subtle">
        To win <b className="font-mono text-accept">{rep(side.payoutMicro)}</b>
      </div>
      <div className={`mt-3 py-1.5 text-sm font-semibold text-white ${tone}`}>Buy {side.label}</div>
    </div>
  );
}

/** The step-2 trade on the first side, as a receipt: the odds, the stake and what it pays if it wins. */
function Receipt({ example }: { example: Example }) {
  const [yes] = example.sides;
  return (
    <div className="w-72 border border-frame bg-card shadow-lg">
      <div className="border-b border-rule-soft p-4 font-serif text-sm leading-snug">
        <span className="line-clamp-2">
          <MathText text={example.title} />
        </span>
      </div>
      <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-4 gap-y-1.5 p-4 text-sm">
        <dt className="text-subtle">Odds</dt>
        <dd className="text-right font-mono">{pct(example.accept)}</dd>
        <dt className="text-subtle">Stake</dt>
        <dd className="text-right font-mono">
          {rep(EXAMPLE_STAKE, 0)} {REP}
        </dd>
        <dt className="text-subtle">To win</dt>
        <dd className="text-right font-mono text-2xl text-accept">{rep(yes.payoutMicro)}</dd>
      </dl>
      <div className="mx-4 mb-4 bg-accent py-1.5 text-center text-sm font-semibold text-white">Cash out</div>
    </div>
  );
}
