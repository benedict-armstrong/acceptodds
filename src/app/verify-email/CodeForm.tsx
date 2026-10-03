'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { CodeInput } from '@/components/CodeInput';
import { ui } from '@/components/ui';
import { authClient } from '@/lib/auth-client';
import { clearPending, rememberPending } from '@/lib/pending-confirmation';
import { authHref, VERIFY_EMAIL } from '@/lib/return-to';
import { welcomeHref } from '@/lib/onboarding';
import { track } from '@/lib/track';

const field =
  'w-full border border-rule-strong bg-white p-[7px] font-sans text-[15px] leading-[normal] text-ink narrow:text-base';

/**
 * The code from the confirmation mail, typed where the person already is.
 * Confirming creates the trader and signs in (Better Auth's
 * `autoSignInAfterVerification`); the page then re-renders signed in and
 * asks for whatever the account still lacks (`Finish`). The link in the same
 * mail does the same from any browser.
 */
export function CodeForm({ initialEmail, next, resent }: { initialEmail: string; next: string; resent: boolean }) {
  const router = useRouter();
  const [email, setEmail] = useState(initialEmail);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const input = useRef<HTMLInputElement>(null);
  // The code was used up (too many guesses) or expired. Better Auth then
  // forgets it, so a later guess, even the right one, reads as merely wrong.
  const [spent, setSpent] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(
    resent ? { ok: true, text: 'We sent you a new code.' } : null,
  );

  useEffect(() => {
    if (initialEmail) rememberPending({ email: initialEmail, next });
  }, [initialEmail, next]);

  // The input is disabled while a code is checked, which drops its focus:
  // give it back after a refusal, so the next code can be typed straight in.
  useEffect(() => {
    if (!busy && note && !note.ok) input.current?.focus();
  }, [busy, note]);

  async function confirm(e: React.FormEvent) {
    e.preventDefault();
    if (busy || code.length !== 6 || !email.trim()) return;
    setBusy(true);
    setNote(null);
    const { error } = await authClient.emailOtp.verifyEmail({ email: email.trim(), otp: code });
    if (error) {
      track('code_failed', { reason: String(error.code ?? error.status) });
      const dead = spent || error.code === 'TOO_MANY_ATTEMPTS' || error.code === 'OTP_EXPIRED';
      setSpent(dead);
      setBusy(false);
      setCode(''); // ready for the next attempt, typed or pasted
      setNote({
        ok: false,
        text: dead
          ? 'That code no longer works. Send a new one below.'
          : error.code === 'INVALID_OTP'
            ? 'That code is not right. Check the newest mail.'
            : (error.message ?? 'Could not confirm.'),
      });
      return;
    }
    track('code_confirmed');
    clearPending();
    router.refresh();
  }

  async function resend() {
    if (!email.trim()) return;
    setBusy(true);
    setNote(null);
    const { error } = await authClient.sendVerificationEmail({
      email: email.trim(),
      callbackURL: authHref(VERIFY_EMAIL, next),
    });
    setBusy(false);
    if (error) {
      setNote({ ok: false, text: error.message ?? 'Could not send a new code.' });
      return;
    }
    track('code_resent');
    rememberPending({ email: email.trim(), next });
    setSpent(false);
    setCode('');
    setNote({ ok: true, text: 'Sent. Only the newest code works.' });
  }

  return (
    <form ref={form} onSubmit={confirm}>
      <p className="my-4">
        {initialEmail ? (
          <>
            We sent a 6-digit code and a link to <b>{initialEmail}</b>. Enter the code here, or open the link. If you
            have no account yet, it and your starting balance are created when you confirm.
          </>
        ) : (
          <>Enter your email and the 6-digit code from the confirmation mail.</>
        )}
      </p>
      {!initialEmail && (
        <label className="mt-2.5 block font-sans text-[13px] text-muted">
          Email
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoComplete="email"
            className={field}
          />
        </label>
      )}
      <div className="mt-2.5 text-center font-sans text-[13px] text-muted">Code</div>
      {/* A pasted or autofilled code confirms by itself; typed, the last digit does too. */}
      <CodeInput
        ref={input}
        value={code}
        onChange={setCode}
        onComplete={() => form.current?.requestSubmit()}
        autoFocus={!!initialEmail}
        disabled={busy}
        aria-label="6-digit code"
      />
      <button className={ui.btn()} disabled={busy || code.length !== 6}>
        Confirm
      </button>
      {note && <div className={ui.note(note.ok)}>{note.text}</div>}
      <p className={`${ui.fine} mb-3`}>
        No mail? Check spam, or{' '}
        <button
          type="button"
          className="cursor-pointer text-accent underline"
          onClick={resend}
          disabled={busy || !email.trim()}
        >
          send a new code
        </button>
        . Wrong address? <Link href={welcomeHref(next)}>Start again</Link>.
      </p>
      <p className={`${ui.fine} mb-3`}>
        <Link href={next}>Keep browsing</Link> while you wait; you can come back here from the banner at the top.
      </p>
    </form>
  );
}
