'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ui } from '@/components/ui';
import { authClient } from '@/lib/auth-client';
import { setPasswordPath } from '@/lib/links';

/**
 * Set the password with the link's token or the mail's code, then sign in
 * with it. Each works once, for an hour; a dead one offers a fresh mail to
 * the same address, which Better Auth sends only if it has an account.
 */
export function SetPasswordForm({
  proof,
  email,
}: {
  proof: { token: string } | { code: string } | null;
  email: string | null;
}) {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [dead, setDead] = useState(proof === null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!proof) return;
    setBusy(true);
    setNote(null);
    const reset =
      'token' in proof
        ? await authClient.resetPassword({ newPassword: password, token: proof.token })
        : await authClient.emailOtp.resetPassword({ email: email!, otp: proof.code, password });
    if (reset.error) {
      setBusy(false);
      if (['INVALID_TOKEN', 'INVALID_OTP', 'OTP_EXPIRED', 'TOO_MANY_ATTEMPTS'].includes(reset.error.code ?? '')) {
        return setDead(true);
      }
      return setNote({ ok: false, text: reset.error.message ?? 'Could not set the password.' });
    }
    const signIn = email ? await authClient.signIn.email({ email, password }) : null;
    if (!signIn || signIn.error) return router.push('/signin');
    router.push('/');
    router.refresh();
  }

  async function resend() {
    if (!email) return;
    setBusy(true);
    setNote(null);
    const { error } = await authClient.requestPasswordReset({ email, redirectTo: setPasswordPath(email) });
    setBusy(false);
    setNote(error ? { ok: false, text: error.message ?? 'Could not send a new link.' } : { ok: true, text: 'Sent. Check your inbox.' });
  }

  if (dead) {
    return (
      <>
        <p className="mb-3">This {proof && 'code' in proof ? 'code' : 'link'} has expired or was already used.</p>
        {email ? (
          <button type="button" className={ui.btn()} disabled={busy} onClick={resend}>
            Send a new link to {email}
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
      {email && (
        <p className="mb-3 text-muted">
          For <b className="text-ink">{email}</b>. You are signed in once it is set.
        </p>
      )}
      {/* For password managers: which account the new password belongs to. */}
      {email && <input type="email" value={email} readOnly hidden autoComplete="username" />}
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
        {busy ? '…' : 'Set password and sign in'}
      </button>
      {note && <div className={ui.note(note.ok)}>{note.text}</div>}
    </form>
  );
}
