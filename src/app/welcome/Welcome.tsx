'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import useSWR from 'swr';
import type { z } from 'zod';
import { MARKDOWN_HINT, MarkdownEditor } from '@/components/MarkdownEditor';
import { MathText } from '@/components/MathText';
import { OnboardingCard } from '@/components/OnboardingCard';
import { MESSAGES } from '@/components/orders';
import { ui } from '@/components/ui';
import { pct, rep, REP } from '@/lib/format';
import { marketHeadline } from '@/lib/headline';
import { marketHref } from '@/lib/links';
import { WELCOME_FINISH, WELCOMED_COOKIE } from '@/lib/onboarding';
import { authHref } from '@/lib/return-to';
import type * as S from '@/server/api/schemas';
import { ConfirmForm } from '../confirm/ConfirmForm';
import { publicJson } from '../markets/[slug]/MarketLive';
import { TradeBox } from '../markets/[slug]/TradeBox';

type Listing = z.output<typeof S.Listing>;
type Market = z.output<typeof S.Market>;

export type Step = 'intro' | 'search' | 'bet' | 'comment' | 'email' | 'confirm';

/** A visitor's steps; a signed-in viewer's stop at the comment, their bet already placed. */
const ANON: Step[] = ['intro', 'search', 'bet', 'comment', 'email', 'confirm'];
const SIGNED_IN: Step[] = ['search', 'bet', 'comment'];
/** A visitor who chose the paper and the bet on the market's own page. */
const CHOSEN: Step[] = ['comment', 'email', 'confirm'];

/** The market bet on, and the paper it is read under. */
interface Pick {
  market: Market;
  /** The paper's title (a standalone market's question). */
  title: string;
  href: string;
}

interface Choice {
  outcomeId: string;
  stakeMicro: bigint;
}

/** A bet chosen on a market's page (`welcomeBetHref`), checked by the page. */
export interface Chosen {
  pick: Pick;
  choice: Choice;
}

/** What a step needs from the ones before it, so a reload or a deep link falls back to where it can start. */
const NEEDS: Partial<Record<Step, 'pick' | 'choice'>> = {
  bet: 'pick',
  comment: 'choice',
  email: 'choice',
  confirm: 'choice',
};

const POLL_MS = 3000;

/** A listing can be bet on in onboarding when its main market is open. */
function tradable(l: Listing): Market | null {
  const m = l.markets[0];
  return m && m.status === 'open' && new Date(m.closesAt).getTime() > Date.now() ? m : null;
}

/**
 * The onboarding flow: one step on screen at a time (`OnboardingCard`), in
 * the URL as `?step=` so the back button works. What the steps collect lives
 * here and is lost on a reload; a step whose inputs are gone falls back to
 * the search.
 *
 * Nothing is placed for a visitor: the bet and the comment go to
 * `POST /onboarding` with their email, and are placed after they confirm
 * (`Finish`). A signed-in viewer's bet and comment go straight to the API.
 *
 * A visitor who chose a bet on a market's page (`chosen`) skips the paper
 * and the bet, starting at the comment; back returns to that page.
 */
export function Welcome({
  kind,
  next,
  suggestions,
  chosen,
  initialStep,
  viewer,
}: {
  kind: string;
  /** Where the intro's sign-in and sign-up links return to. */
  next: string;
  suggestions: Listing[];
  chosen: Chosen | null;
  initialStep: Step | null;
  viewer: { signedIn: boolean; canTrade: boolean; cashMicro: string };
}) {
  const router = useRouter();
  const steps = viewer.signedIn ? SIGNED_IN : chosen ? CHOSEN : ANON;
  const [pick, setPick] = useState<Pick | null>(chosen?.pick ?? null);
  const [choice, setChoice] = useState<Choice | null>(chosen?.choice ?? null);
  const [comment, setComment] = useState('');
  const [email, setEmail] = useState('');

  function reachable(s: Step | null): Step {
    if (!s || !steps.includes(s)) return steps[0];
    const need = NEEDS[s];
    if ((need === 'pick' && !pick) || (need === 'choice' && (!pick || !choice))) return 'search';
    return s;
  }

  const [step, setStep] = useState<Step>(() => reachable(initialStep === null ? null : initialStep));

  function go(s: Step) {
    setStep(s);
    window.history.pushState(null, '', s === steps[0] ? '/welcome' : `/welcome?step=${s}`);
  }

  // Seen: sign-in and sign-up stop sending this browser here.
  useEffect(() => {
    document.cookie = `${WELCOMED_COOKIE}=1; path=/; max-age=31536000; samesite=lax`;
  }, []);

  useEffect(() => {
    const onPop = () => setStep(reachable(new URLSearchParams(window.location.search).get('step') as Step | null));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  });

  const numbered: Step[] = steps.filter((s) => s !== 'intro');
  const card = (title: React.ReactNode, body: React.ReactNode) => {
    const i = numbered.indexOf(step);
    const at = steps.indexOf(step);
    return (
      <OnboardingCard
        step={i < 0 ? undefined : i + 1}
        of={numbered.length}
        title={title}
        // The first of `CHOSEN` goes back to the market's page it came from.
        onBack={(at > 0 || chosen) && step !== 'confirm' ? () => window.history.back() : undefined}
      >
        {body}
      </OnboardingCard>
    );
  };

  switch (step) {
    case 'intro':
      return card(
        'Bet on which papers get in.',
        <>
          <p className="mb-4 text-muted">
            Pick a {kind} paper, stake reputation on its decision. For researchers with an institutional email.
          </p>
          <button className={ui.btn()} onClick={() => go('search')}>
            Start
          </button>
          <p className={`${ui.fine} mt-3 text-center`}>
            Know how it works? <Link href={authHref('/signup', next)}>Sign up</Link> ·{' '}
            <Link href={authHref('/signin', next)}>Sign in</Link>
          </p>
        </>,
      );

    case 'search':
      return card(
        `Which ${kind} paper do you have an opinion on?`,
        <>
          <p className="-mt-2 mb-3 text-muted">Maybe you have a feeling about your own submission?</p>
          <PaperSearch
            kind={kind}
            suggestions={suggestions}
            onPick={(l) => {
              const market = tradable(l) ?? l.markets[0];
              setPick({ market, title: l.title, href: marketHref({ marketSlug: market.slug, listingSlug: l.slug }) });
              setChoice(null);
              go('bet');
            }}
          />
        </>,
      );

    case 'bet':
      return card(
        <MathText text={pick!.title} />,
        <BetStep
          market={pick!.market}
          viewer={viewer}
          onChoose={
            viewer.signedIn
              ? undefined
              : (c) => {
                  setChoice(c);
                  go('comment');
                }
          }
          onFilled={(c) => {
            setChoice(c);
            go('comment');
          }}
        />,
      );

    case 'comment':
      return card(
        <>Why {pick!.market.outcomes.find((o) => o.id === choice!.outcomeId)?.label}? (optional)</>,
        <CommentStep
          marketId={pick!.market.id}
          post={viewer.signedIn}
          value={comment}
          onChange={setComment}
          onDone={() => (viewer.signedIn ? router.push(pick!.href) : go('email'))}
        />,
      );

    case 'email':
      return card(
        'Where should we send your link?',
        <EmailStep
          market={pick!.market}
          choice={choice!}
          comment={comment}
          onSent={(address) => {
            setEmail(address);
            go('confirm');
          }}
        />,
      );

    case 'confirm':
      return card('Check your inbox', <ConfirmForm initialEmail={email} next={WELCOME_FINISH} resent={false} />);
  }
}

/** Search the venue's papers; before anything is typed, the most traded ones. */
function PaperSearch({ kind, suggestions, onPick }: { kind: string; suggestions: Listing[]; onPick: (l: Listing) => void }) {
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);
  const { data, isLoading } = useSWR<z.output<typeof S.ListingList>>(
    debounced ? `/api/v1/listings?kind=${encodeURIComponent(kind)}&q=${encodeURIComponent(debounced)}&limit=8` : null,
    publicJson,
  );
  const shown = (debounced ? (data?.listings ?? []) : suggestions).filter((l) => tradable(l));

  return (
    <>
      <input
        autoFocus
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Title or author"
        aria-label="Search papers"
        className={ui.input}
      />
      {!debounced && shown.length > 0 && <div className="mt-2 text-xs text-faint">Most traded</div>}
      <ul className="mt-1">
        {shown.map((l) => {
          const h = marketHeadline(l.markets[0]);
          return (
            <li key={l.id}>
              <button
                className="flex w-full cursor-pointer items-baseline gap-3 border-b border-rule-soft py-2 text-left hover:text-accent"
                onClick={() => onPick(l)}
              >
                <span className="min-w-0 flex-1 truncate">
                  <MathText text={l.title} />
                </span>
                {h !== null && <span className="font-mono text-[13px] text-muted">{pct(h)}</span>}
              </button>
            </li>
          );
        })}
      </ul>
      {debounced && !isLoading && shown.length === 0 && <div className={ui.empty}>No open {kind} paper matches.</div>}
    </>
  );
}

/** The market's own trade box, kept live. A visitor's hands back the choice; a viewer's places the order. */
function BetStep({
  market: initial,
  viewer,
  onChoose,
  onFilled,
}: {
  market: Market;
  viewer: { signedIn: boolean; canTrade: boolean; cashMicro: string };
  onChoose?: (c: Choice) => void;
  onFilled: (c: Choice) => void;
}) {
  const { data: market = initial } = useSWR<Market>(`/api/v1/markets/${initial.id}`, publicJson, {
    fallbackData: initial,
    refreshInterval: POLL_MS,
  });
  return (
    <>
      <p className="mb-1.5 text-sm text-muted">Current probabilities, set by everyone’s bets. Pick an outcome and stake on it.</p>
      <TradeBox
        market={market}
        cashMicro={BigInt(viewer.cashMicro)}
        viewer={viewer}
        onChoose={onChoose}
        onFilled={onFilled}
      />
    </>
  );
}

/** A justification. Posted now for a viewer; for a visitor, kept for after they confirm. */
function CommentStep({
  marketId,
  post,
  value,
  onChange,
  onDone,
}: {
  marketId: string;
  post: boolean;
  value: string;
  onChange: (v: string) => void;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!post || !value.trim()) return onDone();
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/v1/markets/${marketId}/comments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: value }),
    }).catch(() => null);
    setBusy(false);
    if (res?.ok) return onDone();
    const body = await res?.json().catch(() => null);
    setError(MESSAGES[body?.error?.code] ?? body?.error?.message ?? 'Could not post it.');
  }

  return (
    <>
      <MarkdownEditor value={value} onChange={onChange} preview={preview} autoFocus />
      <div className={`${ui.fine} flex items-baseline justify-between gap-3`}>
        <span>{MARKDOWN_HINT} Anonymous: others see only your stake.</span>
        <button type="button" className={ui.linkBtn} disabled={!value.trim() && !preview} onClick={() => setPreview((p) => !p)}>
          {preview ? 'edit' : 'preview'}
        </button>
      </div>
      <div className="flex gap-2">
        <button className={ui.btn({ ghost: true })} disabled={busy} onClick={() => (onChange(''), onDone())}>
          Skip
        </button>
        <button className={ui.btn()} disabled={busy || !value.trim()} onClick={submit}>
          {post ? 'Post' : 'Next'}
        </button>
      </div>
      {error && <div className={ui.note(false)}>{error}</div>}
    </>
  );
}

/** Name and institutional email: `POST /onboarding` stores the bet and mails a link and a code. */
function EmailStep({
  market,
  choice,
  comment,
  onSent,
}: {
  market: Market;
  choice: Choice;
  comment: string;
  onSent: (email: string) => void;
}) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const label = market.outcomes.find((o) => o.id === choice.outcomeId)?.label;

  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        const address = email.trim();
        const res = await fetch('/api/v1/onboarding', {
          method: 'POST',
          credentials: 'omit',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            email: address,
            name,
            marketId: market.id,
            outcomeId: choice.outcomeId,
            stakeMicro: choice.stakeMicro.toString(),
            comment: comment.trim() || null,
          }),
        }).catch(() => null);
        setBusy(false);
        if (res?.ok) return onSent(address);
        const body = await res?.json().catch(() => null);
        const code = body?.error?.code;
        setError(
          code === 'email_domain_not_allowed'
            ? 'That address is not at an institution on our list.'
            : (MESSAGES[code] ?? body?.error?.message ?? 'Something went wrong.'),
        );
      }}
    >
      <p className="mb-3 text-muted">
        {rep(choice.stakeMicro)} {REP} on {label}, placed when you confirm.
      </p>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        required
        autoComplete="name"
        placeholder="Name"
        aria-label="Name"
        className={ui.input}
      />
      <input
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        required
        autoComplete="email"
        placeholder="Institutional email"
        aria-label="Institutional email"
        className={ui.input}
      />
      <button className={ui.btn()} disabled={busy}>
        Send link
      </button>
      {error && <div className={ui.note(false)}>{error}</div>}
    </form>
  );
}
