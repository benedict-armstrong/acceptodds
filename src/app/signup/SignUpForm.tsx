'use client';

import Link from 'next/link';
import { useState } from 'react';
import { ui } from '@/components/ui';
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
      <p className="my-4">
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
      <label className="mt-2.5 block font-sans text-[13px] text-muted">
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} required autoComplete="name" className="w-full border border-rule-strong bg-white p-[7px] font-sans text-[15px] leading-[normal] text-ink" />
      </label>
      <label className="mt-2.5 block font-sans text-[13px] text-muted">
        Institutional email
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" className="w-full border border-rule-strong bg-white p-[7px] font-sans text-[15px] leading-[normal] text-ink" />
      </label>
      <label className="mt-2.5 block font-sans text-[13px] text-muted">
        Password (12+ characters)
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={12} autoComplete="new-password" className="w-full border border-rule-strong bg-white p-[7px] font-sans text-[15px] leading-[normal] text-ink" />
      </label>
      <button className={ui.btn()} disabled={busy}>
        Sign up
      </button>
      {error && <div className={ui.note(false)}>{error}</div>}
      <p className={`${ui.fine} mb-3`}>
        Have an account? <Link href="/signin">Sign in</Link>.
      </p>
    </form>
  );
}
