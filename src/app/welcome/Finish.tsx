'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { z } from 'zod';
import { Markdown } from '@/components/Markdown';
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
  comment: string | null;
  /** The paper's title (a standalone market's question). */
  title: string;
  href: string;
}

/**
 * Back from the confirmation mail, signed in: choose a password, then place
 * the bet chosen before signing up — through the API like any order, at the
 * price now. The stake is kept, not the share count: it is sized on the
 * fresh board, quoted, and sent with that quote as its bound. Then the
 * comment, then the pending bet is dropped. "Skip" drops it unplaced.
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

  async function place(): Promise<boolean> {
    if (!bet) return true;
    const market: Market = await publicJson(`/api/v1/markets/${bet.market.id}`);
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
      return false;
    }
    const result = await send(bet.outcomeId, label, shares.toString(), quote.costMicro);
    if (!result.ok) {
      setError(result.text);
      return false;
    }
    if (bet.comment) {
      await fetch(`/api/v1/markets/${market.id}/comments`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body: bet.comment }),
      }).catch(() => null);
    }
    return true;
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
    if ((await savePassword()) && (await place())) return leave(bet?.href ?? '/');
    setBusy(false);
  }

  return (
    <OnboardingCard of={1} title={bet ? 'Place your bet' : 'Choose a password'}>
      <form onSubmit={submit}>
        {bet && (
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
            {bet.comment && <Markdown className="mt-2 border-l-2 border-rule pl-2 text-sm text-muted">{bet.comment}</Markdown>}
          </div>
        )}
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
          {busy ? '…' : bet ? 'Place bet' : 'Save'}
        </button>
        {bet && <div className={ui.fine}>At the price now, which may have moved since you chose it.</div>}
        {error && <div className={ui.note(false)}>{error}</div>}
        {bet && error && (
          <button type="button" className={`${ui.linkBtn} mt-3 text-sm`} disabled={busy} onClick={() => leave(bet.href)}>
            Skip the bet
          </button>
        )}
      </form>
    </OnboardingCard>
  );
}
