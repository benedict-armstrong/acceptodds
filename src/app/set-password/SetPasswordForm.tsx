'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ui } from '@/components/ui';
import { authClient } from '@/lib/auth-client';
import { setPasswordPath } from '@/lib/links';

type Proof = { token: string } | { code: string };

/**
 * Set the password of `target` — the account the link's token or the mail's
 * code belongs to — then sign in as it. Each works once, for an hour; a dead
 * one offers a fresh mail to the same address, which Better Auth sends only
 * if it has an account.
 */
export function SetPasswordForm({
  target,
  resendTo,
  signedInAs,
}: {
  target: { email: string; proof: Proof } | null;
  resendTo: string | null;
  /** Set when the viewer is signed in as a different account than `target`. */
  signedInAs: string | null;
}) {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [dead, setDead] = useState(target === null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!target) return;
    setBusy(true);
    setNote(null);
    const { email, proof } = target;
    const reset =
      'token' in proof
        ? await authClient.resetPassword({ newPassword: password, token: proof.token })
        : await authClient.emailOtp.resetPassword({ email, otp: proof.code, password });
    if (reset.error) {
      setBusy(false);
      if (['INVALID_TOKEN', 'INVALID_OTP', 'OTP_EXPIRED', 'TOO_MANY_ATTEMPTS'].includes(reset.error.code ?? '')) {
        return setDead(true);
      }
      return setNote({ ok: false, text: reset.error.message ?? 'Could not set the password.' });
    }
    const signIn = await authClient.signIn.email({ email, password });
    if (signIn.error) return router.push('/signin');
    router.push('/');
    router.refresh();
  }

  async function resend() {
    if (!resendTo) return;
    setBusy(true);
    setNote(null);
    const { error } = await authClient.requestPasswordReset({ email: resendTo, redirectTo: setPasswordPath(resendTo) });
    setBusy(false);
    setNote(error ? { ok: false, text: error.message ?? 'Could not send a new link.' } : { ok: true, text: 'Sent. Check your inbox.' });
  }

  if (dead || !target) {
    return (
      <>
        <p className="mb-3">This link or code has expired or was already used.</p>
        {resendTo ? (
          <button type="button" className={ui.btn()} disabled={busy} onClick={resend}>
            Send a new link to {resendTo}
          </button>
        ) : (
          <Link href="/signin">Sign in</Link>
        )}
        {note && <div className={ui.note(note.ok)}>{note.text}</div>}
      </>
    );
  }

  return (
    <form onSubmit={submit}>
      <p className="mb-3 text-muted">
        For the account <b className="text-ink">{target.email}</b>. You are signed in as it once the password is set.
      </p>
      {signedInAs && (
        <div className={`${ui.note(false)} mb-3`}>
          You are signed in as <b>{signedInAs}</b>, not {target.email}. This sets the password of{' '}
          <b>{target.email}</b> and signs you in as it instead.
        </div>
      )}
      {/* For password managers: which account the new password belongs to. */}
      <input type="email" value={target.email} readOnly hidden autoComplete="username" />
      <input
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        required
        minLength={12}
        autoFocus
        autoComplete="new-password"
        placeholder="Password (12+ characters)"
        aria-label="Password"
        className={ui.input}
      />
      <button className={ui.btn()} disabled={busy}>
        {busy ? '…' : signedInAs ? `Set password and switch to ${target.email}` : 'Set password and sign in'}
      </button>
      {note && <div className={ui.note(note.ok)}>{note.text}</div>}
    </form>
  );
}
