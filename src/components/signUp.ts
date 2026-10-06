'use client';

import { hasSubaddress, SUBADDRESS_REFUSED } from '@/lib/email-address';
import { asksJevPrice } from '@/lib/links';
import { track } from '@/lib/track';
import { MESSAGES } from './orders';

/** `POST /onboarding`'s body: an address, maybe a first bet, maybe where to return after confirming. */
export interface SignUpBody {
  email: string;
  bet?: { marketId: string; outcomeId: string; stakeMicro: string; seenOrderCount: number };
  next?: string;
}

/**
 * Sign up (`POST /onboarding`): mails a link and a code, for a new address
 * or one with an account alike. A `+tag` is refused before sending. The
 * sentence to show, or `null` once sent; tracked either way.
 */
export async function sendSignUp(body: SignUpBody): Promise<string | null> {
  if (hasSubaddress(body.email)) return SUBADDRESS_REFUSED;
  const res = await fetch('/api/v1/onboarding', {
    method: 'POST',
    // Not 'omit': with a bet, the answer sets the cookie that names this
    // browser as the one it was chosen in (`choseHere`).
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).catch(() => null);
  if (res?.ok) {
    // Where it started: a bet chosen before signing up, a paper's "Open Market", or the email alone.
    const target = body.bet ? 'bet' : body.next && asksJevPrice(body.next) ? 'open_market' : 'email';
    track('signup_submitted', { target });
    return null;
  }
  const json = await res?.json().catch(() => null);
  const code = json?.error?.code;
  track('signup_refused', { reason: res ? String(code ?? res.status) : 'network' });
  if (!res) return 'Network error. Try again.';
  if (code === 'email_domain_not_allowed') return 'That address is not at an institution on our list.';
  // The budget is per address and refills over a day (`server/onboarding.ts`), not in a moment.
  if (code === 'rate_limited')
    return 'We have sent this address too many mails today. Open the link in the newest one, or try again in a few hours.';
  return MESSAGES[code] ?? json?.error?.message ?? 'Something went wrong.';
}
