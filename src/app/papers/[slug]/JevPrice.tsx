'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { CodeEntry } from '@/components/CodeEntry';
import { MESSAGES } from '@/components/orders';
import { OutcomeBar, OutcomeSwatch } from '@/components/OutcomeBar';
import { sendSignUp } from '@/components/signUp';
import { SignUpEmail } from '@/components/SignUpEmail';
import { ui } from '@/components/ui';
import { barOrder, headlineLabel } from '@/lib/headline';
import { jevPricePath } from '@/lib/links';
import { track } from '@/lib/track';
import { authHref, VERIFY_EMAIL } from '@/lib/return-to';
import {
  clearPending,
  parsePending,
  readPendingRaw,
  rememberPending,
  subscribePending,
} from '@/lib/pending-confirmation';

/**
 * A paper nobody has opened a market on: its odds figure, as `MarketLive`
 * sets it, drawn blurred over placeholders (an even bar, `??%`: no price
 * exists yet, and none is invented), with "Open Market" over it. That opens the market
 * (`POST /listings/{id}/market`) at JEV's prices, and the page, read again,
 * shows the real figure and the trade box. An invitation to find out, not
 * a note that nobody has traded.
 *
 * Signed out, the button asks for an email right here, over the figure
 * (`SignUpEmail`: `POST /onboarding` with no bet, returning to
 * `?price=jev`), then for the code from the mail (`CodeEntry`). The code step is kept in this browser
 * (`rememberPending`), so coming back to the paper, or any unopened one,
 * asks for the code while one is outstanding, not the email. Confirming by code or by the mail's link signs in and lands on
 * `?price=jev`; a session is only had with a confirmed address, so the
 * market opens only then, by itself. The parameter is dropped on the way to
 * the trade box, so a reload asks nothing.
 */
export function JevPrice({
  listingId,
  slug,
  kind,
  outcomes,
  viewer,
  asked,
}: {
  listingId: string;
  slug: string;
  /** The listing's kind, whose venue names the headline. */
  kind: string | null;
  /** The labels the market will open with, best first (its template's). */
  outcomes: readonly string[];
  viewer: { signedIn: boolean; canTrade: boolean };
  /** `?price=jev`: asked for before signing in. */
  asked: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const here = `/papers/${encodeURIComponent(slug)}`;
  const back = jevPricePath(slug);
  const [emailing, setEmailing] = useState(false);
  // A code sent and not yet typed, from this browser's storage after mount. Asked for here whichever page
  // sent it: the one record is shared with the banner, and anything else that rewrites its `next` (the
  // banner's own "enter code", another sign-up) would otherwise bring the button back.
  const raw = useSyncExternalStore(subscribePending, readPendingRaw, () => null);
  const pending = useMemo(() => (viewer.signedIn ? null : parsePending(raw)), [raw, viewer.signedIn]);
  const awaitingCode = pending?.email ?? null;
  // Sent from this paper: confirming opens its market. Sent from elsewhere, maybe with a bet waiting:
  // confirming goes by `/verify-email` like any other code, and back here to the button.
  const forHere = pending?.next === back;

  async function open(target: 'click' | 'return') {
    setBusy(true);
    setNote(null);
    try {
      const res = await fetch(`/api/v1/listings/${listingId}/market`, { method: 'POST' });
      if (res.ok) {
        track('market_opened', { target });
        router.replace(`${here}#trade`);
        router.refresh();
        return;
      }
      const body = await res.json().catch(() => ({}));
      track('market_open_refused', { reason: String(body.error?.code ?? res.status) });
      setNote(MESSAGES[body.error?.code] ?? body.error?.message ?? 'Something went wrong.');
    } catch {
      track('market_open_refused', { reason: 'network' });
      setNote('Network error. Try again.');
    }
    setBusy(false);
  }

  // Once, on arrival or as soon as a code confirmed here signs in, and never twice under React's
  // double effects in development.
  const started = useRef(false);
  useEffect(() => {
    if (!asked || !viewer.canTrade || started.current) return;
    started.current = true;
    void open('return');
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `open` is this render's, and only runs once
  }, [asked, viewer.canTrade]);

  const n = outcomes.length;
  const signingUp = !viewer.signedIn && (emailing || awaitingCode !== null);
  // What sits over the blurred figure: the code, the email, or the button.
  const over = awaitingCode ? (
    <div className={card}>
      <p className="mb-1">
        Enter the 6-digit code we sent to <b>{awaitingCode}</b>.
      </p>
      <CodeEntry
        email={awaitingCode}
        onConfirmed={() => {
          clearPending();
          router.replace(forHere ? back : authHref(VERIFY_EMAIL, here));
          router.refresh();
        }}
        resend={async () => {
          const next = pending!.next;
          const refused = await sendSignUp({ email: awaitingCode, next });
          if (!refused) rememberPending({ email: awaitingCode, next });
          return refused;
        }}
        autoFocus
        footer={
          <>
            Wrong address?{' '}
            <button type="button" className={ui.linkBtn} onClick={clearPending}>
              Use another
            </button>
            .
          </>
        }
      />
    </div>
  ) : signingUp ? (
    <SignUpEmail
      body={{ next: back }}
      onSent={(email) => rememberPending({ email, next: back })}
      submit="Email me a code"
      autoFocus
      className={card}
      footer={
        <p className={ui.fine}>
          Confirming your address makes your account. No password needed.{' '}
          <button type="button" className={ui.linkBtn} onClick={() => setEmailing(false)}>
            Cancel
          </button>
        </p>
      }
    />
  ) : (
    (viewer.canTrade || !viewer.signedIn) && (
      <button
        type="button"
        className={`${ui.btn({ inline: true, flush: true })} shadow-md`}
        disabled={busy}
        onClick={() => {
          track('market_open_clicked', { signedIn: viewer.signedIn });
          if (viewer.signedIn) void open('click');
          else setEmailing(true);
        }}
      >
        {busy ? 'Opening market…' : LABEL}
      </button>
    )
  );
  return (
    <div className="mx-auto my-7 max-w-[560px] text-center">
      {/* One grid cell for both, so whatever is over the figure is centred on it, and the cell grows to fit a
          form taller than the figure. */}
      <div className="grid place-items-center [&>*]:col-start-1 [&>*]:row-start-1">
        {/* Placeholders only, never a price: an even bar and question marks, blurred past reading. */}
        {/* Padded past its place (and pulled back by as much), so the blur fits inside its own box: overlapped by
            what sits over it, a filter's layer is clipped at that box, which left a hard-edged pale rectangle. */}
        <div
          aria-hidden
          inert
          className="pointer-events-none -m-6 flex transform-gpu flex-col justify-center self-stretch justify-self-stretch p-6 blur-[5px] select-none"
        >
          <div className="mb-2 text-[22px]">
            <b>??%</b> {headlineLabel(outcomes, kind)}
          </div>
          <OutcomeBar prices={outcomes.map(() => 1 / n)} className="h-2.5 w-full" />
          <div className="mt-1.5 flex flex-wrap justify-between gap-x-4 font-sans text-[13px] text-subtle">
            {barOrder(n).map((i) => (
              <span key={i} className="whitespace-nowrap">
                <OutcomeSwatch ordinal={i} outcomes={n} />
                {outcomes[i]} <b className="font-mono text-ink">??%</b>
              </span>
            ))}
          </div>
        </div>
        {/* Positioned, so it paints over the figure: the blur's filter lifts the figure above unpositioned content. */}
        <div className="relative flex w-full justify-center">{over}</div>
      </div>
      {!signingUp && (
        <p className={ui.fine}>Open the market to see its starting price (determined by @TypeSafeAI/JEV).</p>
      )}
      {viewer.signedIn && !viewer.canTrade && <div className={ui.note(false)}>{MESSAGES.not_verified}</div>}
      {note && <div className={ui.note(false)}>{note}</div>}
    </div>
  );
}

/** A sign-up step over the figure: a box of its own, so it reads over the blur. */
const card = `${ui.box} w-full max-w-sm shadow-md`;

const LABEL = 'Open Market';
