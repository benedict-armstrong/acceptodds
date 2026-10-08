'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import type { z } from 'zod';
import { BetSummary } from '@/components/BetSummary';
import { MathText } from '@/components/MathText';
import { OnboardingTrade } from '@/components/OnboardingTrade';
import { OnboardingCard } from '@/components/OnboardingCard';
import { PaperSearch, tradableListingMarket } from '@/components/PaperSearch';
import {
  agentPromptStep,
  AgentPromptButton,
  OnboardAgentButton,
  TutorialArt,
  TutorialText,
  tutorialSteps,
} from '@/components/TutorialModal';
import { SignUpEmail } from '@/components/SignUpEmail';
import { ui } from '@/components/ui';
import { marketHref } from '@/lib/links';
import { WELCOMED_COOKIE } from '@/lib/onboarding';
import { rememberVenue } from '@/lib/venue';
import { venue } from '@/venues';
import { rememberPending } from '@/lib/pending-confirmation';
import { authHref, VERIFY_EMAIL } from '@/lib/return-to';
import type * as S from '@/server/api/schemas';
import type { Choice } from '../markets/[slug]/TradeBox';

type Listing = z.output<typeof S.Listing>;
type Market = z.output<typeof S.Market>;

/** The tutorial's steps, in order: the home page's [getting started], one a page. */
const TOUR = ['pick', 'trade', 'cash-out', 'agent'] as const;
type TourStep = (typeof TOUR)[number];

/** `agent-prompt` is the agent screen past the tour's last step, reached only by "Onboard my agent". */
export type Step = 'intro' | TourStep | 'agent-prompt' | 'search' | 'bet' | 'email';

/**
 * A visitor's steps: the intro, the tutorial, then the bet. A signed-in
 * viewer's skip both and end with the bet, placed, at the paper.
 */
const ANON: Step[] = ['intro', ...TOUR, 'agent-prompt', 'search', 'bet', 'email'];
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

/**
 * "a" or "an" before a venue, read as it is said: an acronym by its letters
 * ("an ICLR", "a NeurIPS", "an EMNLP"), a word by its first letter.
 */
function article(kind: string): 'a' | 'an' {
  const word = kind.split(/\s/)[0] ?? '';
  const acronym = word.length > 1 && word === word.toUpperCase();
  return (acronym ? /^[AEFHILMNORSX]/ : /^[aeiou]/i).test(word) ? 'an' : 'a';
}

/** What a step needs from the ones before it, so a reload or a deep link falls back to where it can start. */
const NEEDS: Partial<Record<Step, 'pick' | 'choice'>> = {
  bet: 'pick',
  email: 'choice',
};

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
  venues,
  next,
  suggestions,
  sparks,
  canOpen,
  chosen,
  viewer,
}: {
  kind: string;
  /** The venues a paper may be picked from, offered under the search when there are several. */
  venues: string[];
  /** Where the intro's sign-in link returns to. */
  next: string;
  suggestions: Listing[];
  /** The suggestions' sparklines, by market id. */
  sparks: Record<string, number[]>;
  /** Whether a paper with no market may be picked, its market opened at JEV's price (`PaperSearch`). */
  canOpen: boolean;
  chosen: Chosen | null;
  viewer: { signedIn: boolean; canTrade: boolean; cashMicro: string };
}) {
  const router = useRouter();
  const steps = viewer.signedIn ? SIGNED_IN : chosen ? CHOSEN : ANON;
  const [pick, setPick] = useState<Pick | null>(chosen?.pick ?? null);
  const [choice, setChoice] = useState<Choice | null>(chosen?.choice ?? null);
  /** A paper picked with no market: the bet step opens it, then it is the pick. */
  const [opening, setOpening] = useState<Listing | null>(null);
  function reachable(s: Step | null): Step {
    if (!s || !steps.includes(s)) return steps[0];
    const need = NEEDS[s];
    if ((need === 'pick' && !pick && !opening) || (need === 'choice' && (!pick || !choice))) return 'search';
    return s;
  }

  // The step is the URL's, so back and forward move through the steps.
  // Next.js keeps `useSearchParams` in step with `pushState` and history
  // traversal alike; a `popstate` listener of our own lost to its router.
  const params = useSearchParams();
  const step = reachable(params.get('step') as Step | null);

  /** `/welcome` at step `s`, keeping a venue chosen in the URL. */
  function href(s: Step, venue = params.get('kind')): string {
    const q = new URLSearchParams();
    if (s !== steps[0]) q.set('step', s);
    if (venue) q.set('kind', venue);
    return q.size ? `/welcome?${q}` : '/welcome';
  }

  function go(s: Step) {
    window.history.pushState(null, '', href(s));
  }

  /** Search another venue: remembered for next time, and read again on the server for its papers. */
  function chooseVenue(venue: string) {
    rememberVenue(venue);
    router.replace(href('search', venue));
  }

  // Seen: sign-in and sign-up stop sending this browser here.
  useEffect(() => {
    document.cookie = `${WELCOMED_COOKIE}=1; path=/; max-age=31536000; samesite=lax`;
  }, []);

  const card = (title: React.ReactNode, body: React.ReactNode, wide = false, figure?: React.ReactNode) => {
    const at = steps.indexOf(step);
    return (
      <OnboardingCard
        title={title}
        // The first of `CHOSEN` goes back to the market's page it came from.
        onBack={at > 0 || chosen ? () => window.history.back() : undefined}
        // Every step past the intro says it is still part of getting started, the name the home page's link uses:
        // the search looks like the home list, and would otherwise read as having left the flow.
        eyebrow={step === 'intro' ? undefined : 'Getting started · your first trade'}
        wide={wide}
        figure={figure}
      >
        {body}
      </OnboardingCard>
    );
  };

  switch (step) {
    case 'intro':
      return card(
        venue(kind)?.cardTitle ?? 'Bet on what becomes of papers.',
        <>
          <p className="mb-4 text-muted">
            Pick a {kind} paper, stake reputation on how it fares. For researchers with an institutional email.
          </p>
          <button className={ui.btn()} onClick={() => go(TOUR[0])}>
            Get started
          </button>
          <p className={`${ui.fine} mt-3 text-center`}>
            Already have an account? <Link href={authHref('/signin', next)}>Sign in</Link>
          </p>
        </>,
      );

    case 'pick':
    case 'trade':
    case 'cash-out':
    case 'agent': {
      const at = TOUR.indexOf(step);
      const tour = tutorialSteps({ example: suggestions[0], startingBalanceMicro: viewer.cashMicro, signedIn: false });
      const last = at === TOUR.length - 1;
      return card(
        `${at + 1}. ${tour[at].title}`,
        <>
          <TutorialText step={tour[at]} />
          <div className="mt-6">
            <button className={ui.btn()} onClick={() => go(last ? 'search' : TOUR[at + 1])}>
              {last ? 'Make your first trade' : 'Next'}
            </button>
            {last && <OnboardAgentButton onClick={() => go('agent-prompt')} />}
          </div>
        </>,
        false,
        tour[at].art && <TutorialArt>{tour[at].art}</TutorialArt>,
      );
    }

    case 'agent-prompt': {
      const screen = agentPromptStep(viewer.signedIn);
      return card(
        screen.title,
        <>
          <TutorialText step={screen} />
          <div className="mt-6">
            <AgentPromptButton signedIn={viewer.signedIn} />
          </div>
        </>,
        false,
        <TutorialArt>{screen.art}</TutorialArt>,
      );
    }

    case 'search':
      return card(
        `Pick ${article(kind)} ${kind} paper`,
        <>
          <p className="-mt-2 mb-3 text-muted">Maybe you have a feeling about your own submission?</p>
          <PaperSearch
            kind={kind}
            suggestions={suggestions}
            sparks={sparks}
            canOpen={canOpen}
            below={
              venues.length > 1 && (
                <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 font-sans text-[13px] text-muted">
                  Venue:
                  {venues.map((v) =>
                    v === kind ? (
                      <span key={v} className={ui.on}>
                        {v}
                      </span>
                    ) : (
                      <button key={v} type="button" className={ui.linkBtn} onClick={() => chooseVenue(v)}>
                        {v}
                      </button>
                    ),
                  )}
                </div>
              )
            }
            onPick={(l) => {
              const market = tradableListingMarket(l);
              setPick(
                market && {
                  market,
                  title: l.title,
                  href: marketHref({ marketSlug: market.slug, listingSlug: l.slug }),
                },
              );
              setOpening(market ? null : l);
              setChoice(null);
              go('bet');
            }}
          />
        </>,
        true,
      );

    case 'bet':
      if (!pick) {
        return card(
          <MathText text={opening!.title} />,
          <OpenMarket
            listing={opening!}
            onOpened={(market) => {
              setPick({
                market,
                title: opening!.title,
                href: marketHref({ marketSlug: market.slug, listingSlug: opening!.slug }),
              });
              setOpening(null);
            }}
          />,
        );
      }
      return card(
        <MathText text={pick!.title} />,
        <OnboardingTrade
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

/**
 * The first price of a paper nobody has opened a market on: its market,
 * opened now at JEV's prices (`POST /listings/{id}/market`, which a visitor
 * may call without an account), then the bet as on any other. Once, even
 * under React's double effects in development; the call is idempotent anyway.
 */
function OpenMarket({ listing, onOpened }: { listing: Listing; onOpened: (market: Market) => void }) {
  const [note, setNote] = useState<string | null>(null);
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void (async () => {
      try {
        const res = await fetch(`/api/v1/listings/${listing.id}/market`, { method: 'POST' });
        const body = await res.json().catch(() => ({}));
        if (res.ok) return onOpened(body.market as Market);
        setNote(
          res.status === 429
            ? 'Too many new markets were opened today. Try again later, or pick a paper that already has one.'
            : (body.error?.message ?? 'Something went wrong.'),
        );
      } catch {
        setNote('Network error. Go back and pick the paper again.');
      }
    })();
  }, [listing.id, onOpened]);
  return note ? (
    <p className="my-4 text-muted">{note}</p>
  ) : (
    <p className="my-4 text-muted" aria-live="polite">
      Nobody has traded this paper yet. Opening its market…
    </p>
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
  return (
    <SignUpEmail
      body={{
        bet: {
          marketId: market.id,
          outcomeId: choice.outcomeId,
          stakeMicro: choice.stakeMicro.toString(),
          seenOrderCount: choice.seenOrderCount,
        },
      }}
      onSent={onSent}
      submit="Send link"
    >
      <BetSummary title={title} market={market} outcomeId={choice.outcomeId} stakeMicro={choice.stakeMicro} />
    </SignUpEmail>
  );
}
