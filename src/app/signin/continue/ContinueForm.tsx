'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ui } from '@/components/ui';

/**
 * A name and a password for the signed-in account, whichever it lacks:
 * `PATCH /me` and `POST /me/password`, both as the session. Then `next`.
 */
export function ContinueForm({
  email,
  needsName,
  needsPassword,
  next,
}: {
  email: string;
  needsName: boolean;
  needsPassword: boolean;
  next: string;
}) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    if (needsName) {
      const res = await fetch('/api/v1/me', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ displayName: name }),
      }).catch(() => null);
      if (!res?.ok) {
        setBusy(false);
        return setError('Could not save your name.');
      }
    }
    if (needsPassword) {
      const res = await fetch('/api/v1/me/password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password }),
      }).catch(() => null);
      const code = res?.ok ? null : (await res?.json().catch(() => null))?.error?.code;
      if (!res?.ok && code !== 'password_already_set') {
        setBusy(false);
        return setError(code === 'validation_error' ? 'At least 12 characters.' : 'Could not save your password.');
      }
    }
    router.push(next);
    router.refresh();
  }

  return (
    <form onSubmit={submit}>
      <p className="mb-3 text-muted">
        Signed in as <b className="text-ink">{email}</b>.{' '}
        {needsName
          ? 'Your name and a password, to sign in next time without a link.'
          : 'A password, to sign in next time without a link.'}
      </p>
      {needsName && (
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          maxLength={100}
          autoFocus
          autoComplete="name"
          placeholder="Name"
          aria-label="Name"
          className={ui.input}
        />
      )}
      {needsPassword && (
        <>
          <input type="email" value={email} readOnly hidden autoComplete="username" />
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={12}
            autoFocus={!needsName}
            autoComplete="new-password"
            placeholder="Password (12+ characters)"
            aria-label="Password"
            className={ui.input}
          />
        </>
      )}
      <button className={ui.btn()} disabled={busy}>
        {busy ? '…' : 'Continue'}
      </button>
      {error && <div className={ui.note(false)}>{error}</div>}
    </form>
  );
}
