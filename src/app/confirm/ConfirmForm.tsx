'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { CodeInput } from '@/components/CodeInput';
import { ui } from '@/components/ui';
import { authClient } from '@/lib/auth-client';
import { setPasswordPath } from '@/lib/links';
import { clearPending, rememberPending } from '@/lib/pending-confirmation';
import { authHref } from '@/lib/return-to';

const field = 'w-full border border-rule-strong bg-white p-[7px] font-sans text-[15px] leading-[normal] text-ink narrow:text-base';

/**
 * The code from the confirmation mail, typed where the person already is.
 * Confirming creates the trader and signs in (Better Auth's
 * `autoSignInAfterVerification`), then returns to `next`. The link in the
 * same mail does the same from any browser.
 *
 * A code from the "choose a password" mail (an account confirmed before, with
 * no password yet) works here too: it goes on to `/set-password` with it.
 */
export function ConfirmForm({ initialEmail, next, resent }: { initialEmail: string; next: string; resent: boolean }) {
  const router = useRouter();
  const [email, setEmail] = useState(initialEmail);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(
    resent ? { ok: true, text: 'We sent you a new code.' } : null,
  );

  useEffect(() => {
    if (initialEmail) rememberPending({ email: initialEmail, next });
  }, [initialEmail, next]);

  async function confirm(e: React.FormEvent) {
    e.preventDefault();
    if (busy || code.length !== 6 || !email.trim()) return;
    setBusy(true);
    setNote(null);
    const address = email.trim();
    const { error } = await authClient.emailOtp.verifyEmail({ email: address, otp: code });
    // Not a confirmation code: an account that is already confirmed but has
    // no password is mailed a code to choose one (`sendResetPassword`). The
    // page it was typed on cannot tell, so try that too.
    if (error?.code === 'INVALID_OTP') {
      const { error: notPassword } = await authClient.emailOtp.checkVerificationOtp({
        email: address,
        type: 'forget-password',
        otp: code,
      });
      if (!notPassword) {
        clearPending();
        router.push(setPasswordPath(address, code));
        return;
      }
    }
    if (error) {
      setBusy(false);
      setCode(''); // ready for the next attempt, typed or pasted
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
    <form ref={form} onSubmit={confirm}>
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
      <div className="mt-2.5 font-sans text-[13px] text-muted">Code</div>
      {/* A pasted or autofilled code confirms by itself; typed, the last digit does too. */}
      <CodeInput
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
