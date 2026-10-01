'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import type { z } from 'zod';
import { BetSummary } from '@/components/BetSummary';
import { OnboardingCard } from '@/components/OnboardingCard';
import { useOrder } from '@/components/orders';
import { sharesForStake } from '@/components/quote';
import { ui } from '@/components/ui';
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
  /** The paper's title (a standalone market's question). */
  title: string;
  href: string;
}

/**
 * What a signed-in account still owes after confirming its address, on
 * one page, a view at a time: a name (saved as soon as it is entered), then a
 * password, and the bet chosen
 * before signing up. Whichever is missing is asked for, then the bet is
 * placed and the person goes on to the bet's paper (or `next`, with no bet).
 *
 * The bet is placed through the API like any order, at the price now. The
 * stake is kept, not the share count: it is sized on the fresh board,
 * quoted, and sent with that quote as its bound. Then the pending bet is
 * dropped. "Skip" drops it unplaced.
 *
 * If this is the browser the bet was chosen in, and no fill has moved the
 * market since (its `orderCount` is the one seen then), the board is the one
 * the person saw, so the same stake buys the same shares at the same cost:
 * the bet is placed at once, without asking, and only the name and password
 * are left. Otherwise it is shown at the price now, to place or skip — in
 * another browser because it may not be the person's own bet at all.
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
  const { send } = useOrder(bet?.market.id ?? '', () => {});
  const label = bet?.market.outcomes.find((o) => o.id === bet.outcomeId)?.label ?? '';
  const unmoved =
    bet !== null && bet.choseHere && bet.seenOrderCount !== null && bet.market.orderCount === bet.seenOrderCount;
  // 'auto' while placing an unmoved bet by itself; 'moved' if it moved after all.
  const [auto, setAuto] = useState<'auto' | 'moved' | null>(unmoved ? 'auto' : null);
  const [placed, setPlaced] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (!bet || !unmoved || started.current) return;
    started.current = true;
    void (async () => {
      const result = await place(bet.seenOrderCount);
      if (result === 'moved') return setAuto('moved');
      setAuto(null);
      if (result === 'placed') {
        await fetch('/api/v1/me/pending-bet', { method: 'DELETE' }).catch(() => null);
        if (passwordSet && nameSet) return leave(bet.href);
      }
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
   * Place the bet at the price now. With `onlyAt`, only if the market's
   * `orderCount` is still that, else `'moved'` and nothing is sent.
   */
  async function place(onlyAt?: number | null): Promise<'placed' | 'moved' | 'failed'> {
    if (!bet || placed) return 'placed';
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
    const result = await send(bet.outcomeId, label, shares.toString(), quote.costMicro);
    if (!result.ok) {
      setError(result.text);
      return 'failed';
    }
    setPlaced(result.text);
    return 'placed';
  }

  async function leave(to: string) {
    if (bet) await fetch('/api/v1/me/pending-bet', { method: 'DELETE' }).catch(() => null);
    router.push(to);
    router.refresh();
  }

  /** Place the bet if one is waiting, then go on. On a failure the person stays, with the error. */
  async function finish() {
    if (bet && !placed && (await place()) !== 'placed') return setBusy(false);
    await leave(bet?.href ?? next);
  }

  /** The name is saved as soon as it is entered; the password, if still owed, is the next view. */
  async function submitName(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    if (!(await saveName())) return setBusy(false);
    if (passwordSet) return finish();
    setBusy(false);
  }

  async function submitPassword(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    if (!(await savePassword())) return setBusy(false);
    await finish();
  }

  async function submitBet(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    await finish();
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

  const view = !nameSet ? 'name' : !passwordSet ? 'password' : 'bet';
  const title = { name: 'Finish signing up', password: 'Choose a password', bet: 'Place your bet' }[view];

  return (
    <OnboardingCard title={title}>
      <form onSubmit={view === 'name' ? submitName : view === 'password' ? submitPassword : submitBet}>
        {/* The account's username, for password managers. Without it Safari
            takes the text field before a new password (the name) for the
            username and offers an email address there. */}
        <input type="email" value={email} readOnly hidden autoComplete="username" />
        <p className="mb-3 text-muted">
          Signed in as <b className="text-ink">{email}</b>.
        </p>
        {bet && (
          <BetSummary
            title={bet.title}
            market={bet.market}
            outcomeId={bet.outcomeId}
            stakeMicro={BigInt(bet.stakeMicro)}
          />
        )}
        {placed && <div className={`${ui.note(true)} mb-4`}>Bet placed.</div>}
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
        {view === 'bet' && (
          <button className={ui.btn()} disabled={busy}>
            {busy ? '…' : bet && !placed ? 'Place bet' : 'Continue'}
          </button>
        )}
        {bet && !placed && (
          <div className={ui.fine}>
            {!bet.choseHere
              ? 'This bet was chosen in another browser, or by someone else using your address. Place it only if it is yours.'
              : auto === 'moved' || !unmoved
                ? 'The market has moved since you chose this bet: it is placed at the price now.'
                : 'At the price now.'}
          </div>
        )}
        {error && <div className={ui.note(false)}>{error}</div>}
        {bet && !placed && error && (
          <button
            type="button"
            className={`${ui.linkBtn} mt-3 text-sm`}
            disabled={busy}
            onClick={() => leave(bet.href)}
          >
            Skip the bet
          </button>
        )}
      </form>
    </OnboardingCard>
  );
}
