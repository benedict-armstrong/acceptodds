'use client';

import { useEffect, useRef, useState } from 'react';
import { authClient } from '@/lib/auth-client';
import { track } from '@/lib/track';
import { CodeInput } from './CodeInput';
import { ui } from './ui';

/**
 * The 6-digit code from a confirmation mail, checked with Better Auth
 * (`/email-otp/verify-email`), which confirms the address and signs in:
 * `/verify-email`'s `CodeForm` and a paper's `JevPrice`. A pasted or
 * autofilled code confirms by itself; typed, the last digit does too.
 *
 * Under the button, "No mail? … send a new code" calls `resend` (the error
 * to show, or `null` once sent), then `footer`.
 */
export function CodeEntry({
  email,
  onConfirmed,
  resend,
  autoFocus,
  initialNote = null,
  className,
  footer,
}: {
  /** The address the code was sent to; nothing is checked while it is blank. */
  email: string;
  onConfirmed: () => void;
  resend: () => Promise<string | null>;
  autoFocus?: boolean;
  initialNote?: string | null;
  className?: string;
  footer?: React.ReactNode;
}) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const input = useRef<HTMLInputElement>(null);
  // The code was used up (too many guesses) or expired. Better Auth then
  // forgets it, so a later guess, even the right one, reads as merely wrong.
  const [spent, setSpent] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(
    initialNote ? { ok: true, text: initialNote } : null,
  );

  // The input is disabled while a code is checked, which drops its focus:
  // give it back after a refusal, so the next code can be typed straight in.
  useEffect(() => {
    if (!busy && note && !note.ok) input.current?.focus();
  }, [busy, note]);

  async function confirm(e: React.FormEvent) {
    e.preventDefault();
    if (busy || code.length !== 6 || !email) return;
    setBusy(true);
    setNote(null);
    const { error } = await authClient.emailOtp.verifyEmail({ email, otp: code });
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
    onConfirmed();
  }

  async function sendAgain() {
    if (!email) return;
    setBusy(true);
    setNote(null);
    const refused = await resend();
    setBusy(false);
    if (refused) return setNote({ ok: false, text: refused });
    track('code_resent');
    setSpent(false);
    setCode('');
    setNote({ ok: true, text: 'Sent. Only the newest code works.' });
  }

  return (
    <form ref={form} onSubmit={confirm} className={className}>
      <CodeInput
        ref={input}
        value={code}
        onChange={setCode}
        onComplete={() => form.current?.requestSubmit()}
        autoFocus={autoFocus}
        disabled={busy}
        aria-label="6-digit code"
      />
      <button className={ui.btn()} disabled={busy || code.length !== 6 || !email}>
        {busy ? 'Confirming…' : 'Confirm'}
      </button>
      {note && <div className={ui.note(note.ok)}>{note.text}</div>}
      <p className={`${ui.fine} mb-3`}>
        No mail? Check spam, or{' '}
        <button type="button" className={ui.linkBtn} onClick={sendAgain} disabled={busy || !email}>
          send a new code
        </button>
        . {footer}
      </p>
    </form>
  );
}
