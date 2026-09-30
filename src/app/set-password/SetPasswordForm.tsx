'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ui } from '@/components/ui';
import { authClient } from '@/lib/auth-client';
import { setPasswordPath } from '@/lib/links';

/**
 * Set the password with the link's token, then sign in with it. A link
 * works once, for an hour; a dead one offers a fresh one to the same
 * address, which Better Auth mails only if it has an account.
 */
export function SetPasswordForm({ token, email }: { token: string | null; email: string | null }) {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [dead, setDead] = useState(token === null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!token) return;
    setBusy(true);
    setNote(null);
    const reset = await authClient.resetPassword({ newPassword: password, token });
    if (reset.error) {
      setBusy(false);
      if (reset.error.code === 'INVALID_TOKEN') return setDead(true);
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
        <p className="mb-3">This link has expired or was already used.</p>
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
