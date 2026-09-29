'use client';

import Link from 'next/link';
import { useState } from 'react';
import { authClient } from '@/lib/auth-client';

export function SignUpForm() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  if (sent) {
    return (
      <p>
        Check <b>{email}</b> for a confirmation link. Your account and starting balance are created when you confirm.
      </p>
    );
  }

  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        const { error } = await authClient.signUp.email({ name, email, password, callbackURL: '/' });
        setBusy(false);
        if (error) setError(error.message ?? 'Could not sign up.');
        else setSent(true);
      }}
    >
      <label>
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} required autoComplete="name" />
      </label>
      <label>
        Institutional email
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />
      </label>
      <label>
        Password (12+ characters)
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={12} autoComplete="new-password" />
      </label>
      <button className="btn" disabled={busy}>
        Sign up
      </button>
      {error && <div className="note err">{error}</div>}
      <p className="fine">
        Have an account? <Link href="/signin">Sign in</Link>.
      </p>
    </form>
  );
}
