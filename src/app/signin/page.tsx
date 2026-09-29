'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { authClient } from '@/lib/auth-client';

export default function SignIn() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <main className="auth">
      <h1>Sign in</h1>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          const { error } = await authClient.signIn.email({ email, password });
          setBusy(false);
          if (error) {
            setError(error.status === 403 ? 'Confirm your email first: check your inbox for the link.' : error.message ?? 'Could not sign in.');
            return;
          }
          router.push('/');
          router.refresh();
        }}
      >
        <label>
          Email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />
        </label>
        <label>
          Password
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="current-password" />
        </label>
        <button className="btn" disabled={busy}>
          Sign in
        </button>
        {error && <div className="note err">{error}</div>}
      </form>
      <p className="fine">
        No account? <Link href="/signup">Sign up</Link>.
      </p>
    </main>
  );
}
