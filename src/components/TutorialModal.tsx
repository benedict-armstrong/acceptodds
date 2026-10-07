'use client';

import { useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import type { z } from 'zod';
import { OnboardAgent } from '@/components/OnboardAgent';
import { MathText } from '@/components/MathText';
import { Modal, ModalClose, ModalTitle, ModalTrigger, SheetContent } from '@/components/Modal';
import { OutcomeBar, OutcomeSwatch } from '@/components/OutcomeBar';
import { sharesForStake } from '@/components/quote';
import { segment, slotOf } from '@/app/markets/[slug]/TradeBox';
import { ui } from '@/components/ui';
import { AGENT_START_PATH } from '@/lib/agent-prompt';
import { payoutReturn, pct, rep, REP } from '@/lib/format';
import { marketHeadline, TIER_STRONG_BG } from '@/lib/headline';
import { LIKELIHOOD_CLASS, likelihood } from '@/lib/likelihood';
import { prices } from '@/lib/lmsr';
import { unitsToMicro } from '@/lib/money';
import { track } from '@/lib/track';
import type * as S from '@/server/api/schemas';

type Listing = z.output<typeof S.Listing>;

const STEP_TITLE = 'font-serif text-2xl font-normal';

/** Hanson (2007), the market maker's source; `/how-it-works` cites it too. */
const LMSR_PAPER = 'https://mason.gmu.edu/~rhanson/mktscore.pdf';

/** The stake the illustrations price. Only the stake is an example: what it pays is the market's own quote. */
const EXAMPLE_STAKE = unitsToMicro(100);

/** One side of the example market, and the example stake's trade on it, priced by the engine's own maths. */
type Side = {
  label: string;
  ordinal: number;
  price: number;
  /** The shares the stake buys, which is also the payout: each pays 1 if its outcome happens. */
  payoutMicro: bigint;
  /** The side's price once the stake is bought. */
  priceAfter: number;
};

/** The example market, read for the illustrations. */
type Example = {
  title: string;
  authors: string[];
  accept: number;
  /** By ordinal, as the outcome bar takes them. */
  outcomes: { label: string; price: number }[];
  /** The first outcome and the last: for a paper, Accept and Reject. */
  sides: [Side, Side];
};

function exampleOf(listing?: Listing): Example | null {
  const market = listing?.markets[0];
  const accept = market ? marketHeadline(market) : null;
  if (!listing || !market || accept === null || market.status !== 'open') return null;
  const q = market.outcomes.map((o) => Number(o.sharesMicro));
  const side = (i: number): Side => {
    const o = market.outcomes[i];
    const payoutMicro = sharesForStake(market, i, EXAMPLE_STAKE);
    const after = q.slice();
    after[i] += Number(payoutMicro);
    return {
      label: o.label,
      ordinal: o.ordinal,
      price: o.price,
      payoutMicro,
      priceAfter: prices(after, market.b)[i],
    };
  };
  const byOrdinal = market.outcomes.map((o, i) => ({ o, i })).sort((a, b) => a.o.ordinal - b.o.ordinal);
  return {
    title: listing.title,
    authors: listing.authors,
    accept,
    outcomes: byOrdinal.map(({ o }) => ({ label: o.label, price: o.price })),
    sides: [side(byOrdinal[0].i), side(byOrdinal[byOrdinal.length - 1].i)],
  };
}

/** One step of the tutorial: an illustration, when there is an example market, and its text. */
export type TutorialStep = { title: string; art: ReactNode; body: ReactNode; fine?: ReactNode };

/**
 * The tutorial's steps, after Polymarket's: pick a paper, place a trade,
 * cash out; then an AI agent instead, whose button (`OnboardAgentButton`)
 * the last step shows under its own. The illustrations are drawn from one real open market;
 * without one, the steps are text alone. Shown as a sheet by `TutorialModal`
 * and in line, one step a page, by `/welcome`.
 */
export function tutorialSteps({
  example: listing,
  startingBalanceMicro,
  signedIn,
}: {
  example?: Listing;
  startingBalanceMicro: string;
  signedIn: boolean;
}): TutorialStep[] {
  const example = exampleOf(listing);
  const [yes, no] = example?.sides.map((side) => side.label) ?? ['Accept', 'Reject'];
  return [
    {
      title: 'Pick a paper',
      art: example && <ListSketch example={example} />,
      body: (
        <>
          Buy ‘{yes}’ or ‘{no}’ depending on your prediction. Odds shift in real time as other traders weigh in.
        </>
      ),
      fine: (
        <>
          Odds are set by Hanson’s logarithmic market scoring rule: see{' '}
          <Link href="/how-it-works#maker" className="underline">
            How it works
          </Link>
          , or{' '}
          <a href={LMSR_PAPER} target="_blank" rel="noopener noreferrer" className="underline">
            the paper
          </a>
          .
        </>
      ),
    },
    {
      title: 'Place a trade',
      art: example && <TradeBoxSketch example={example} />,
      body: (
        <>
          {signedIn ? 'Every account starts with' : 'Sign up with your institutional email and get'}{' '}
          <span className="font-mono whitespace-nowrap text-ink">
            {rep(startingBalanceMicro, 0)} {REP}
          </span>
          {signedIn ? '. Choose a side and a stake, and you’re trading.' : ' then you’re ready to trade.'}
        </>
      ),
      fine: <>{REP} is in app money, with no cash value. Trading needs an email at a research institution.</>,
    },
    {
      title: 'Cash out',
      art: example && <PositionSketch example={example} />,
      body: (
        <>
          Sell your shares at any time, or wait until the decision to redeem each winning share for 1 {REP}.{' '}
          {signedIn
            ? 'Pick a paper and place your first trade.'
            : 'Create an account and place your first trade in minutes.'}
        </>
      ),
    },
    agentStep(signedIn),
  ];
}

/** The last step: an AI agent instead. Its button, which copies the prompt, sits under the step's own. */
function agentStep(signedIn: boolean): TutorialStep {
  return {
    title: 'Or onboard your agent',
    art: <AgentSketch />,
    body: (
      <>
        Sort through the slop with your agent!{' '}
        {signedIn
          ? 'Paste a prompt into your AI agent, and it trades for you.'
          : 'Paste a prompt into your AI agent: it signs in with a code we email you.'}
      </>
    ),
  };
}

/** The tutorial's second button on its last step: copies the prompt for an AI agent. */
export function OnboardAgentButton({ signedIn }: { signedIn: boolean }) {
  return (
    <OnboardAgent
      signedIn={signedIn}
      className={ui.btn({ ghost: true })}
      label="Onboard my agent"
      copiedLabel="Prompt copied"
    />
  );
}

/** A step's illustration, faded towards the top, as if it rose out of the page. */
export function TutorialArt({ children }: { children: ReactNode }) {
  return (
    <div
      className="relative flex h-60 items-center justify-center [mask-image:linear-gradient(to_top,black_45%,transparent)]"
      aria-hidden="true"
    >
      {children}
    </div>
  );
}

/** A step's paragraph and its fine print. */
export function TutorialText({ step }: { step: TutorialStep }) {
  return (
    <>
      <p className="mt-3 font-serif text-base leading-relaxed text-subtle">{step.body}</p>
      {step.fine && <p className="mt-4 text-xs text-muted">{step.fine}</p>}
    </>
  );
}

/**
 * The tutorial behind [getting started]: its steps in a modal on a wide
 * screen, a bottom sheet on a phone, each with one button.
 */
export function TutorialModal({
  example,
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
  /** The furthest step reached since the tutorial was opened. */
  const reached = useRef(0);
  const steps = tutorialSteps({ example, startingBalanceMicro, signedIn });
  const last = steps.length - 1;
  const current = steps[step];

  function go(next: number) {
    // Each step counted once per opening, however often the arrow keys go back over it.
    if (next > reached.current) {
      reached.current = next;
      track('tutorial_step', { step: next + 1 });
    }
    setStep(next);
    content.current?.scrollTo({ top: 0 });
  }

  return (
    <Modal
      open={open}
      onOpenChange={(value) => {
        setOpen(value);
        if (value) {
          setStep(0);
          reached.current = 0;
          track('tutorial_opened');
        }
      }}
    >
      <ModalTrigger type="button" className={`font-sans text-base font-semibold ${ui.linkBtn}`}>
        [getting started]
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
        {/* The way back is the first thing on the left, as on `/welcome`'s cards (`OnboardingCard`). The row is kept
            on the first step, so the illustration does not jump between steps. */}
        <div className="min-h-5">
          {step > 0 && (
            <button
              type="button"
              className="-ml-1 cursor-pointer px-1 font-sans text-sm text-muted hover:text-ink"
              onClick={() => go(step - 1)}
            >
              ← Back
            </button>
          )}
        </div>
        {current.art && <TutorialArt>{current.art}</TutorialArt>}
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
              <TutorialText step={s} />
            </div>
          ))}
        </div>
        <div className="mt-6">
          {step < last ? (
            <button type="button" className={ui.btn()} onClick={() => go(step + 1)}>
              Next
            </button>
          ) : signedIn ? (
            <ModalClose className={ui.btn()} onClick={() => track('tutorial_finished', { target: 'close' })}>
              Make your first trade
            </ModalClose>
          ) : (
            <Link
              href="/welcome?step=search"
              className={ui.btn()}
              onClick={() => {
                track('tutorial_finished', { target: 'welcome' });
                setOpen(false);
              }}
            >
              Make your first trade
            </Link>
          )}
          {step === last && <OnboardAgentButton signedIn={signedIn} />}
        </div>
      </SheetContent>
    </Modal>
  );
}

/** Shown at the size the illustrations are set in, and never wider than the sheet. */
const SKETCH = 'w-80 max-w-full shadow-lg';

/** "A, B, C et al.", as the home list names authors. */
function authorLine(names: string[]): string {
  return names.length > 3 ? `${names.slice(0, 3).join(', ')} et al.` : names.join(', ');
}

/** The home list, as its rows look: the paper between two blank rows, with its odds and outcome bar. */
function ListSketch({ example }: { example: Example }) {
  const look = LIKELIHOOD_CLASS[likelihood(example.accept)];
  const blank = (
    <div className="grid grid-cols-[3px_1fr_56px] items-center gap-x-3 border-b border-dotted border-rule-strong py-2.5">
      <span className="self-stretch bg-rule-soft" />
      <span className="space-y-1.5">
        <span className="block h-2.5 w-11/12 bg-rule-soft" />
        <span className="block h-2 w-1/2 bg-rule-soft" />
      </span>
      <span className="ml-auto block h-2.5 w-8 bg-rule-soft" />
    </div>
  );
  return (
    <div className={`${SKETCH} -rotate-2 border border-frame bg-card px-3`}>
      {blank}
      <div className="grid grid-cols-[3px_1fr_56px] items-center gap-x-3 border-b border-dotted border-rule-strong py-2">
        <span className={`self-stretch ${look.bar}`} />
        <span className="min-w-0 leading-[1.35]">
          <span className="line-clamp-2 font-serif text-sm">
            <MathText text={example.title} />
          </span>
          {example.authors.length > 0 && (
            <span className="block truncate text-xs text-muted">{authorLine(example.authors)}</span>
          )}
        </span>
        <span className={`inline-flex flex-col items-end gap-1 font-mono text-sm ${look.text}`}>
          {pct(example.accept)}
          <OutcomeBar
            prices={example.outcomes.map((o) => o.price)}
            labels={example.outcomes.map((o) => o.label)}
            className="h-1 w-14"
          />
        </span>
      </div>
      {blank}
    </div>
  );
}

/** The trade box with the example stake on the first side: its segments, stake line, quote and button. */
function TradeBoxSketch({ example }: { example: Example }) {
  const [yes] = example.sides;
  const n = example.outcomes.length;
  const fill = slotOf(yes.ordinal, n);
  const ret = payoutReturn(yes.payoutMicro, EXAMPLE_STAKE);
  return (
    <div className={`${SKETCH} rotate-1 ${ui.box}`}>
      <div className="mb-2 flex gap-1.5">
        {example.sides.map((side) => (
          <span key={side.label} className={`text-center ${segment(side === yes, slotOf(side.ordinal, n))}`}>
            {side.label} {pct(side.price)}
          </span>
        ))}
      </div>
      <div className="mb-3 flex items-baseline justify-center gap-2 text-xl font-semibold text-muted">
        stake
        <span className="border-b-2 border-dashed border-rule-strong font-mono text-3xl text-accent">
          {rep(EXAMPLE_STAKE, 0)}
        </span>
        <span className="font-mono">{REP}</span>
      </div>
      <div className={ui.kv}>
        <span>Payout if {yes.label}</span>
        <b>
          {rep(yes.payoutMicro)} {REP}
          {ret && <span className="ml-1.5 font-normal text-muted">({ret})</span>}
        </b>
      </div>
      <div className={ui.kv}>
        <span>Price</span>
        <span>
          {pct(yes.price, true)} → {pct(yes.priceAfter, true)}
        </span>
      </div>
      <div className={ui.btn({ fill: fill === null ? '' : TIER_STRONG_BG[fill] })}>
        Stake {rep(EXAMPLE_STAKE)} {REP} on {yes.label}
      </div>
    </div>
  );
}

/** The prompt pasted into an agent in a terminal: its first lines, and the agent starting to sign in. */
function AgentSketch() {
  return (
    <div className={`${SKETCH} -rotate-1 overflow-hidden rounded-md bg-ink font-mono text-[11px] leading-relaxed`}>
      <div className="flex items-center gap-1.5 border-b border-white/10 px-3 py-1.5">
        {[0, 1, 2].map((i) => (
          <span key={i} className="size-2 rounded-full bg-white/25" />
        ))}
        <span className="ml-2 text-white/40">~ agent</span>
      </div>
      <div className="px-3 pt-2 pb-3 text-white/80">
        <p>
          <span className="text-toss-up">&gt;</span> trade on acceptodds.com
        </p>
        <p className="pl-3">1. Read the instructions: {AGENT_START_PATH}</p>
        <p className="pl-3">
          2. My own papers are: <span className="inline-block h-3 w-1.5 translate-y-0.5 bg-white/80" />
        </p>
        <p className="mt-2 text-white/50">
          <span className="text-accept-soft">●</span> Read {AGENT_START_PATH}
        </p>
        <p>
          <span className="text-accept-soft">●</span> Which email should I sign in with?
        </p>
      </div>
    </div>
  );
}

/** The step-2 trade as the positions table shows it, with the Sell button. */
function PositionSketch({ example }: { example: Example }) {
  const [yes] = example.sides;
  // What the position returns if its outcome wins: the payout against the stake. Never a mark (§1.1).
  const gain = yes.payoutMicro - EXAMPLE_STAKE;
  const gainPct = Math.round((Number(gain < 0n ? -gain : gain) / Number(EXAMPLE_STAKE)) * 100);
  return (
    <div className="w-[22rem] max-w-full border border-frame bg-card px-3 pt-2 pb-6 shadow-lg">
      <span className="line-clamp-1 font-serif text-sm">
        <MathText text={example.title} />
      </span>
      <table className={`${ui.table} text-[13px]`}>
        <thead>
          <tr>
            <th className={ui.th()}>Outcome</th>
            <th className={`${ui.th(true)}`}>Staked</th>
            <th className={`${ui.th(true)}`}>Payout</th>
            <th className={`${ui.th(true)}`}>Return</th>
            <th className={ui.th()} />
          </tr>
        </thead>
        <tbody>
          <tr>
            <td className={`${ui.td} whitespace-nowrap`}>
              <OutcomeSwatch ordinal={yes.ordinal} outcomes={example.outcomes.length} />
              {yes.label}
            </td>
            <td className={`${ui.td} ${ui.num}`}>{rep(EXAMPLE_STAKE)}</td>
            <td className={`${ui.td} ${ui.num} font-bold text-up`}>{rep(yes.payoutMicro)}</td>
            <td className={`${ui.td} ${ui.num} ${ui.pnl(gain)}`}>
              {gain < 0n ? '−' : '+'}
              {gainPct}%
            </td>
            <td className={`${ui.td} text-right`}>
              <span className={ui.btn({ inline: true, flush: true })}>Sell</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
