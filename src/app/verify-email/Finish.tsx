'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import type { z } from 'zod';
import { BetSummary } from '@/components/BetSummary';
import { OnboardingCard } from '@/components/OnboardingCard';
import { useOrder } from '@/components/orders';
import { sharesForStake } from '@/components/quote';
import { ui } from '@/components/ui';
import { FIRST_TRADE_PATH } from '@/lib/links';
import { track } from '@/lib/track';
import type * as S from '@/server/api/schemas';
import { publicJson } from '../markets/[slug]/MarketLive';

type Market = z.output<typeof S.Market>;

export interface PendingBet {
  market: Market;
  outcomeId: string;
  stakeMicro: string;
  /** The market's `orderCount` when the bet was chosen; `null` when not recorded. */
  seenOrderCount: number | null;
  /**
   * Whether this browser is the one the bet was chosen in. Anyone may replace
   * an unconfirmed address's pending bet, so only then is it placed unasked.
   */
  choseHere: boolean;
  /** The bet's `Idempotency-Key` (`pendingBetOrderKey`): it fills once, however many tabs place it. */
  orderKey: string;
  /** Whether the market still trades (open, before `closes_at`); a closed one's bet can only be dropped. */
  tradable: boolean;
  /** The paper's title (a standalone market's question). */
  title: string;
  href: string;
}

/**
 * What a signed-in account still owes after confirming its address, on one
 * page, a view at a time: first the bet chosen before signing up, then a name
 * (saved as soon as it is entered), then a password. Whichever is missing is
 * asked for, then the person goes on to the bet's paper (or `next`, with no
 * bet).
 *
 * The bet comes first, and a first trade goes straight to the first-trade
 * page, whose "Continue" brings the person back here for the name and
 * password (`/verify-email` asks for whatever is still missing). The pending
 * bet is dropped before that, so it is never shown or placed twice.
 *
 * The bet is placed through the API like any order, at the price now. The
 * stake is kept, not the share count: it is sized on the fresh board,
 * quoted, and sent with that quote as its bound. "Skip" drops it unplaced.
 * Its `Idempotency-Key` is the bet's own (`orderKey`), so two tabs placing
 * it fill it once: the second gets the original fill, or a 409 when it was
 * sized on a board that has moved, which is taken as placed.
 *
 * If this is the browser the bet was chosen in, and no fill has moved the
 * market since (its `orderCount` is the one seen then), the board is the one
 * the person saw, so the same stake buys the same shares at the same cost:
 * the bet is placed at once, without asking. Otherwise it is shown at the
 * price now, to place or skip — in another browser because it may not be the
 * person's own bet at all, which is why skipping it there goes on to `next`
 * rather than to its paper. A bet on a market that has closed since can only
 * be dropped.
 *
 * A bet that is not the account's first trade, placed with nothing else
 * owed, ends on a "Bet placed" view rather than going on unannounced.
 */
export function Finish({
  bet,
  email,
  needsName,
  needsPassword,
  next,
}: {
  bet: PendingBet | null;
  email: string;
  needsName: boolean;
  needsPassword: boolean;
  next: string;
}) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [nameSet, setNameSet] = useState(!needsName);
  const [password, setPassword] = useState('');
  const [passwordSet, setPasswordSet] = useState(!needsPassword);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The pending bet is dropped before the first-trade page, so this goes there itself.
  const { send } = useOrder(bet?.market.id ?? '', () => {}, { firstTradePage: false });
  const label = bet?.market.outcomes.find((o) => o.id === bet.outcomeId)?.label ?? '';
  const unmoved =
    bet !== null &&
    bet.tradable &&
    bet.choseHere &&
    bet.seenOrderCount !== null &&
    bet.market.orderCount === bet.seenOrderCount;
  // 'auto' while placing an unmoved bet by itself; 'moved' if it moved after all.
  const [auto, setAuto] = useState<'auto' | 'moved' | null>(unmoved ? 'auto' : null);
  // Placed or skipped: nothing more to do with the bet.
  const [betDone, setBetDone] = useState(bet === null);
  // What the placed bet bought (`useOrder`'s text), shown once it is.
  const [placed, setPlaced] = useState<string | null>(null);
  const started = useRef(false);
  // Where the person goes once nothing is owed: the bet's paper, unless it was skipped as not theirs.
  const [done, setDone] = useState(bet?.href ?? next);

  // Signed in and confirmed, with something still owed: where the next drop-off would be.
  useEffect(() => {
    track('finish_shown', { bet: bet !== null, needsName, needsPassword });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!bet || !unmoved || started.current) return;
    started.current = true;
    void (async () => {
      const result = await place(bet.seenOrderCount);
      if (result === 'moved') return setAuto('moved');
      if (result === 'failed') return setAuto(null);
    })();
    // Once, on arrival: the bet is placed at most once by itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function saveName(): Promise<boolean> {
    if (nameSet) return true;
    const res = await fetch('/api/v1/me', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: name }),
    }).catch(() => null);
    if (res?.ok) {
      setNameSet(true);
      return true;
    }
    setError('Could not save your name.');
    return false;
  }

  async function savePassword(): Promise<boolean> {
    if (passwordSet) return true;
    const res = await fetch('/api/v1/me/password', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
    }).catch(() => null);
    const code = res?.ok ? null : (await res?.json().catch(() => null))?.error?.code;
    if (res?.ok || code === 'password_already_set') {
      setPasswordSet(true);
      return true;
    }
    setError(code === 'validation_error' ? 'At least 12 characters.' : 'Could not save your password.');
    return false;
  }

  /**
   * Place the bet at the price now, then move on (`betSettled`). With
   * `onlyAt`, only if the market's `orderCount` is still that, else
   * `'moved'` and nothing is sent.
   */
  async function place(onlyAt?: number | null): Promise<'placed' | 'moved' | 'failed'> {
    if (!bet) return 'placed';
    const market: Market | null = await publicJson(`/api/v1/markets/${bet.market.id}`).catch(() => null);
    if (!market) {
      setError('Could not price the bet. Try again.');
      return 'failed';
    }
    if (onlyAt !== undefined && market.orderCount !== onlyAt) return 'moved';
    const idx = market.outcomes.findIndex((o) => o.id === bet.outcomeId);
    const shares = sharesForStake(market, idx, BigInt(bet.stakeMicro));
    const quote = await fetch(`/api/v1/markets/${market.id}/quote`, {
      method: 'POST',
      credentials: 'omit',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ outcomeId: bet.outcomeId, sharesMicro: shares.toString() }),
    }).then(
      (r) => (r.ok ? r.json() : null),
      () => null,
    );
    if (!quote) {
      setError('Could not price the bet. Try again.');
      return 'failed';
    }
    const result = await send(bet.outcomeId, label, shares.toString(), quote.costMicro, bet.orderKey);
    if (result.code === 'idempotency_key_reused') {
      // Placed already, in another tab, on a board that has moved since.
      await betSettled({ placed: 'already placed this bet in another tab.', firstTrade: false, to: bet.href });
      return 'placed';
    }
    if (!result.ok) {
      setError(result.text);
      return 'failed';
    }
    await betSettled({ placed: result.text, firstTrade: !!result.firstTrade, to: bet.href });
    return 'placed';
  }

  /**
   * The bet is placed or skipped: drop it, then on to the first-trade page
   * for a first trade, else to the name and password, or, when nothing is
   * owed, to "Bet placed" or straight on to `to` for a skipped one.
   */
  async function betSettled({ placed, firstTrade, to }: { placed: string | null; firstTrade: boolean; to: string }) {
    await fetch('/api/v1/me/pending-bet', { method: 'DELETE' }).catch(() => null);
    if (firstTrade) {
      router.push(FIRST_TRADE_PATH);
      router.refresh();
      return;
    }
    if (nameSet && passwordSet && !placed) return leave(to);
    setDone(to);
    setPlaced(placed);
    setBetDone(true);
    setAuto(null);
    setBusy(false);
  }

  function leave(to: string) {
    track('finish_completed', { bet: bet !== null });
    router.push(to);
    router.refresh();
  }

  async function submitBet(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    if ((await place()) !== 'placed') setBusy(false);
  }

  async function skipBet() {
    if (!bet) return;
    setBusy(true);
    setError(null);
    await betSettled({ placed: null, firstTrade: false, to: bet.choseHere ? bet.href : next });
  }

  /** The name is saved as soon as it is entered; the password, if still owed, is the next view. */
  async function submitName(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    if (!(await saveName())) return setBusy(false);
    if (passwordSet) return leave(done);
    setBusy(false);
  }

  async function submitPassword(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    if (!(await savePassword())) return setBusy(false);
    leave(done);
  }

  if (bet && auto === 'auto') {
    return (
      <OnboardingCard title="Placing your bet">
        <BetSummary
          title={bet.title}
          market={bet.market}
          outcomeId={bet.outcomeId}
          stakeMicro={BigInt(bet.stakeMicro)}
        />
        <div className="text-muted">…</div>
      </OnboardingCard>
    );
  }

  // "Bet placed" only when nothing else was ever owed: after a name or
  // password, the person goes straight on (the placed bet was shown above them).
  const view = !betDone ? 'bet' : !needsName && !needsPassword ? 'placed' : !nameSet ? 'name' : 'password';
  const title = {
    bet: bet?.tradable === false ? 'This market has closed' : 'Place your bet',
    placed: 'Bet placed',
    name: 'Add your name',
    password: 'Set a password',
  }[view];

  if (view === 'placed') {
    return (
      <OnboardingCard title={title}>
        <p className="mb-4">You {placed}</p>
        <button className={ui.btn()} onClick={() => leave(done)}>
          Continue
        </button>
      </OnboardingCard>
    );
  }

  return (
    <OnboardingCard title={title} eyebrow={view === 'bet' ? undefined : 'Finish signing up'}>
      <form onSubmit={view === 'bet' ? submitBet : view === 'name' ? submitName : submitPassword}>
        {/* The account's username, for password managers. Without it Safari
            takes the text field before a new password (the name) for the
            username and offers an email address there. */}
        <input type="email" value={email} readOnly hidden autoComplete="username" />
        <p className="mb-3 text-muted">
          Signed in as <b className="text-ink">{email}</b>.
        </p>
        {view === 'bet' && bet && (
          <>
            <BetSummary
              title={bet.title}
              market={bet.market}
              outcomeId={bet.outcomeId}
              stakeMicro={BigInt(bet.stakeMicro)}
            />
            {!bet.tradable ? (
              <>
                <p className="mb-3 text-muted">It closed before the bet could be placed, so nothing was staked.</p>
                <button type="button" className={ui.btn()} disabled={busy} onClick={skipBet}>
                  {busy ? '…' : 'Continue'}
                </button>
              </>
            ) : (
              <>
                <button className={ui.btn()} disabled={busy}>
                  {busy ? '…' : 'Place bet'}
                </button>
                <div className={ui.fine}>
                  {!bet.choseHere
                    ? 'This bet was chosen in another browser, or by someone else using your address. Place it only if it is yours.'
                    : auto === 'moved' || !unmoved
                      ? 'The market has moved since you chose this bet: it is placed at the price now.'
                      : 'At the price now.'}
                </div>
              </>
            )}
          </>
        )}
        {placed && view !== 'bet' && <div className={`${ui.note(true)} mb-4`}>Bet placed: you {placed}</div>}
        {view === 'name' && (
          <>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={100}
              name="name"
              autoComplete="name"
              autoCapitalize="words"
              placeholder="Name"
              aria-label="Name"
              className={ui.input}
            />
            <button className={ui.btn()} disabled={busy || !name.trim()}>
              {busy ? '…' : passwordSet ? 'Finish' : 'Continue'}
            </button>
          </>
        )}
        {view === 'password' && (
          <>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={12}
              autoComplete="new-password"
              placeholder="Choose a password (12+ characters)"
              aria-label="Password"
              className={ui.input}
            />
            <button className={ui.btn()} disabled={busy || !password}>
              {busy ? '…' : 'Finish'}
            </button>
          </>
        )}
        {error && <div className={ui.note(false)}>{error}</div>}
        {view === 'bet' && bet?.tradable && (
          <button type="button" className={`${ui.linkBtn} mt-3 text-sm`} disabled={busy} onClick={skipBet}>
            Skip the bet
          </button>
        )}
      </form>
    </OnboardingCard>
  );
}
