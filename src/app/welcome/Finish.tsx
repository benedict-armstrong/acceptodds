'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import type { z } from 'zod';
import { MathText } from '@/components/MathText';
import { OnboardingCard } from '@/components/OnboardingCard';
import { useOrder } from '@/components/orders';
import { sharesForStake } from '@/components/quote';
import { ui } from '@/components/ui';
import { rep, REP } from '@/lib/format';
import type * as S from '@/server/api/schemas';
import { publicJson } from '../markets/[slug]/MarketLive';

type Market = z.output<typeof S.Market>;

export interface PendingBet {
  market: Market;
  outcomeId: string;
  stakeMicro: string;
  /** The market's `orderCount` when the bet was chosen; `null` when not recorded. */
  seenOrderCount: number | null;
  /** The paper's title (a standalone market's question). */
  title: string;
  href: string;
}

/**
 * Back from the confirmation mail, signed in: place the bet chosen before
 * signing up — through the API like any order, at the price now — and
 * choose a password. The stake is kept, not the share count: it is sized on
 * the fresh board, quoted, and sent with that quote as its bound. Then the
 * pending bet is dropped. "Skip" drops it unplaced.
 *
 * If no fill has moved the market since the bet was chosen (its
 * `orderCount` is the one seen then), the board is the one the person saw,
 * so the same stake buys the same shares at the same cost: the bet is
 * placed at once, without asking, and only the password is left. Otherwise
 * it is shown at the price now, to place or skip.
 *
 * With no bet (placed, or the address was already registered) it only asks
 * for the password.
 */
export function Finish({ bet, needsPassword }: { bet: PendingBet | null; needsPassword: boolean }) {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [passwordSet, setPasswordSet] = useState(!needsPassword);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { send } = useOrder(bet?.market.id ?? '', () => {});
  const label = bet?.market.outcomes.find((o) => o.id === bet.outcomeId)?.label ?? '';
  const unmoved = bet !== null && bet.seenOrderCount !== null && bet.market.orderCount === bet.seenOrderCount;
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
        if (passwordSet) return leave(bet.href);
      }
    })();
    // Once, on arrival: the bet is placed at most once by itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    }).then((r) => (r.ok ? r.json() : null), () => null);
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

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    if ((await savePassword()) && (await place()) === 'placed') return leave(bet?.href ?? '/');
    setBusy(false);
  }

  if (bet && auto === 'auto') {
    return (
      <OnboardingCard of={1} title="Placing your bet">
        <BetSummary bet={bet} label={label} />
        <div className="text-muted">…</div>
      </OnboardingCard>
    );
  }

  return (
    <OnboardingCard of={1} title={bet && !placed ? 'Place your bet' : 'Choose a password'}>
      <form onSubmit={submit}>
        {bet && <BetSummary bet={bet} label={label} />}
        {placed && <div className={`${ui.note(true)} mb-4`}>Placed: {placed}</div>}
        {!passwordSet && (
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
        )}
        <button className={ui.btn()} disabled={busy}>
          {busy ? '…' : bet && !placed ? 'Place bet' : 'Save'}
        </button>
        {bet && !placed && (
          <div className={ui.fine}>
            {auto === 'moved' || !unmoved
              ? 'The market has moved since you chose this bet: it is placed at the price now.'
              : 'At the price now.'}
          </div>
        )}
        {error && <div className={ui.note(false)}>{error}</div>}
        {bet && !placed && error && (
          <button type="button" className={`${ui.linkBtn} mt-3 text-sm`} disabled={busy} onClick={() => leave(bet.href)}>
            Skip the bet
          </button>
        )}
      </form>
    </OnboardingCard>
  );
}

/** The bet as chosen: the paper, the stake and outcome. */
function BetSummary({ bet, label }: { bet: PendingBet; label: string }) {
  return (
    <div className="mb-4">
      <div className="text-muted">
        <MathText text={bet.title} />
      </div>
      <div className="mt-1 text-lg">
        <b className="font-mono">
          {rep(BigInt(bet.stakeMicro))} {REP}
        </b>{' '}
        on <b>{label}</b>
      </div>
    </div>
  );
}
