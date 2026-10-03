'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import useSWR from 'swr';
import type { z } from 'zod';
import { BetSummary } from '@/components/BetSummary';
import { MathText } from '@/components/MathText';
import { OnboardingCard } from '@/components/OnboardingCard';
import { MESSAGES } from '@/components/orders';
import { ui } from '@/components/ui';
import { pct } from '@/lib/format';
import { marketHeadline } from '@/lib/headline';
import { hasSubaddress, SUBADDRESS_REFUSED } from '@/lib/email-address';
import { marketHref } from '@/lib/links';
import { WELCOMED_COOKIE } from '@/lib/onboarding';
import { rememberPending } from '@/lib/pending-confirmation';
import { track } from '@/lib/track';
import { authHref, VERIFY_EMAIL } from '@/lib/return-to';
import type * as S from '@/server/api/schemas';
import { publicJson } from '../markets/[slug]/MarketLive';
import { TradeBox, type Choice } from '../markets/[slug]/TradeBox';

type Listing = z.output<typeof S.Listing>;
type Market = z.output<typeof S.Market>;

export type Step = 'intro' | 'search' | 'bet' | 'email';

/** A visitor's steps; a signed-in viewer's end with the bet, placed, at the paper. */
const ANON: Step[] = ['intro', 'search', 'bet', 'email'];
const SIGNED_IN: Step[] = ['search', 'bet'];
/** A visitor who chose the paper and the bet on the market's own page. */
const CHOSEN: Step[] = ['email'];

/** The market bet on, and the paper it is read under. */
interface Pick {
  market: Market;
  /** The paper's title (a standalone market's question). */
  title: string;
  href: string;
}

/** A bet chosen on a market's page (`welcomeBetHref`), checked by the page. */
export interface Chosen {
  pick: Pick;
  choice: Choice;
}

/** What a step needs from the ones before it, so a reload or a deep link falls back to where it can start. */
const NEEDS: Partial<Record<Step, 'pick' | 'choice'>> = {
  bet: 'pick',
  email: 'choice',
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
 * Nothing is placed for a visitor: the bet goes to `POST /onboarding` with
 * their email, and is placed once they have confirmed (`/verify-email`). A signed-in
 * viewer's bet goes straight to the API.
 *
 * A visitor who chose a bet on a market's page (`chosen`) skips the paper
 * and the bet, starting at the email; back returns to that page.
 */
export function Welcome({
  kind,
  next,
  suggestions,
  chosen,
  viewer,
}: {
  kind: string;
  /** Where the intro's sign-in link returns to. */
  next: string;
  suggestions: Listing[];
  chosen: Chosen | null;
  viewer: { signedIn: boolean; canTrade: boolean; cashMicro: string };
}) {
  const router = useRouter();
  const steps = viewer.signedIn ? SIGNED_IN : chosen ? CHOSEN : ANON;
  const [pick, setPick] = useState<Pick | null>(chosen?.pick ?? null);
  const [choice, setChoice] = useState<Choice | null>(chosen?.choice ?? null);
  function reachable(s: Step | null): Step {
    if (!s || !steps.includes(s)) return steps[0];
    const need = NEEDS[s];
    if ((need === 'pick' && !pick) || (need === 'choice' && (!pick || !choice))) return 'search';
    return s;
  }

  // The step is the URL's, so back and forward move through the steps.
  // Next.js keeps `useSearchParams` in step with `pushState` and history
  // traversal alike; a `popstate` listener of our own lost to its router.
  const step = reachable(useSearchParams().get('step') as Step | null);

  function go(s: Step) {
    window.history.pushState(null, '', s === steps[0] ? '/welcome' : `/welcome?step=${s}`);
  }

  // Seen: sign-in and sign-up stop sending this browser here.
  useEffect(() => {
    document.cookie = `${WELCOMED_COOKIE}=1; path=/; max-age=31536000; samesite=lax`;
  }, []);

  const card = (title: React.ReactNode, body: React.ReactNode) => {
    const at = steps.indexOf(step);
    return (
      <OnboardingCard
        title={title}
        // The first of `CHOSEN` goes back to the market's page it came from.
        onBack={at > 0 || chosen ? () => window.history.back() : undefined}
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
            Already have an account? <Link href={authHref('/signin', next)}>Sign in</Link>
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
                  go('email');
                }
          }
          onFilled={() => router.push(pick!.href)}
        />,
      );

    case 'email':
      return card(
        'Confirm your email to place your bet',
        <EmailStep
          market={pick!.market}
          title={pick!.title}
          choice={choice!}
          onSent={(address) => {
            // On to the page every mail's link and code lead to.
            rememberPending({ email: address, next: '/' });
            router.push(authHref(VERIFY_EMAIL, '/', { email: address }));
          }}
        />,
      );
  }
}

/** Search the venue's papers; before anything is typed, the most traded ones. */
function PaperSearch({
  kind,
  suggestions,
  onPick,
}: {
  kind: string;
  suggestions: Listing[];
  onPick: (l: Listing) => void;
}) {
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
      <p className="mb-1.5 text-sm text-muted">
        Current probabilities, set by everyone’s bets. Pick an outcome and stake on it.
      </p>
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

/** Institutional email: `POST /onboarding` stores the bet and mails a link and a code. */
function EmailStep({
  market,
  title,
  choice,
  onSent,
}: {
  market: Market;
  title: string;
  choice: Choice;
  onSent: (email: string) => void;
}) {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        const address = email.trim();
        if (hasSubaddress(address)) return setError(SUBADDRESS_REFUSED);
        setBusy(true);
        setError(null);
        const res = await fetch('/api/v1/onboarding', {
          method: 'POST',
          // Not 'omit': the answer sets the cookie that names this browser as
          // the one the bet was chosen in (`choseHere`).
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            email: address,
            marketId: market.id,
            outcomeId: choice.outcomeId,
            stakeMicro: choice.stakeMicro.toString(),
            seenOrderCount: choice.seenOrderCount,
          }),
        }).catch(() => null);
        setBusy(false);
        if (res?.ok) {
          track('signup_submitted');
          return onSent(address);
        }
        const body = await res?.json().catch(() => null);
        const code = body?.error?.code;
        track('signup_refused', { reason: res ? String(code ?? res.status) : 'network' });
        setError(
          code === 'email_domain_not_allowed'
            ? 'That address is not at an institution on our list.'
            : code === 'rate_limited'
              ? // The budget is per address and refills over a day (`server/onboarding.ts`), not in a moment.
                'We have sent this address too many mails today. Open the link in the newest one, or try again in a few hours.'
              : (MESSAGES[code] ?? body?.error?.message ?? 'Something went wrong.'),
        );
      }}
    >
      <BetSummary title={title} market={market} outcomeId={choice.outcomeId} stakeMicro={choice.stakeMicro} />
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
      <button className={ui.btn()} disabled={busy || !email.trim()}>
        Send link
      </button>
      {error && <div className={ui.note(false)}>{error}</div>}
    </form>
  );
}
