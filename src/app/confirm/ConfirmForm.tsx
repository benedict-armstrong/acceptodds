'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ui } from '@/components/ui';
import { authClient } from '@/lib/auth-client';
import { clearPending, rememberPending } from '@/lib/pending-confirmation';
import { authHref } from '@/lib/return-to';

const field = 'w-full border border-rule-strong bg-white p-[7px] font-sans text-[15px] leading-[normal] text-ink';

/**
 * The code from the confirmation mail, typed where the person already is.
 * Confirming creates the trader and signs in (Better Auth's
 * `autoSignInAfterVerification`), then returns to `next`. The link in the
 * same mail does the same from any browser.
 */
export function ConfirmForm({ initialEmail, next, resent }: { initialEmail: string; next: string; resent: boolean }) {
  const router = useRouter();
  const [email, setEmail] = useState(initialEmail);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(
    resent ? { ok: true, text: 'We sent you a new code.' } : null,
  );

  useEffect(() => {
    if (initialEmail) rememberPending({ email: initialEmail, next });
  }, [initialEmail, next]);

  async function confirm(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setNote(null);
    const { error } = await authClient.emailOtp.verifyEmail({ email: email.trim(), otp: code.trim() });
    if (error) {
      setBusy(false);
      setNote({
        ok: false,
        text:
          error.code === 'TOO_MANY_ATTEMPTS' || error.code === 'OTP_EXPIRED'
            ? 'That code no longer works. Send a new one below.'
            : error.code === 'INVALID_OTP'
              ? 'That code is not right. Check the newest mail.'
              : (error.message ?? 'Could not confirm.'),
      });
      return;
    }
    clearPending();
    router.push(next);
    router.refresh();
  }

  async function resend() {
    if (!email.trim()) return;
    setBusy(true);
    setNote(null);
    const { error } = await authClient.sendVerificationEmail({ email: email.trim(), callbackURL: next });
    setBusy(false);
    if (error) {
      setNote({ ok: false, text: error.message ?? 'Could not send a new code.' });
      return;
    }
    rememberPending({ email: email.trim(), next });
    setCode('');
    setNote({ ok: true, text: 'Sent. Only the newest code works.' });
  }

  return (
    <form onSubmit={confirm}>
      <p className="my-4">
        {initialEmail ? (
          <>
            We sent a 6-digit code and a link to <b>{initialEmail}</b>. Enter the code here, or open the link. Your
            account and starting balance are created when you confirm.
          </>
        ) : (
          <>Enter your email and the 6-digit code from the confirmation mail.</>
        )}
      </p>
      {!initialEmail && (
        <label className="mt-2.5 block font-sans text-[13px] text-muted">
          Email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" className={field} />
        </label>
      )}
      <label className="mt-2.5 block font-sans text-[13px] text-muted">
        Code
        <input
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
          required
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="\d{6}"
          maxLength={6}
          autoFocus
          className={`${field} font-mono tracking-[.3em]`}
        />
      </label>
      <button className={ui.btn()} disabled={busy || code.length !== 6}>
        Confirm
      </button>
      {note && <div className={ui.note(note.ok)}>{note.text}</div>}
      <p className={`${ui.fine} mb-3`}>
        No mail? Check spam, or{' '}
        <button type="button" className="cursor-pointer text-accent underline" onClick={resend} disabled={busy || !email.trim()}>
          send a new code
        </button>
        . Wrong address? <Link href={authHref('/signup', next)}>Sign up again</Link>.
      </p>
      <p className={`${ui.fine} mb-3`}>
        <Link href={next}>Keep browsing</Link> while you wait; you can come back here from the banner at the top.
      </p>
    </form>
  );
}
