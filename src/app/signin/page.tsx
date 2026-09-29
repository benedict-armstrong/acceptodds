'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ui } from '@/components/ui';
import { authClient } from '@/lib/auth-client';

export default function SignIn() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <main className="mx-auto my-10 max-w-[360px]">
      <h1 className="my-4.5 text-[26px] font-normal">Sign in</h1>
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
        <label className="mt-2.5 block font-sans text-[13px] text-muted">
          Email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" className="w-full border border-rule-strong bg-white p-[7px] font-sans text-[15px] leading-[normal] text-ink" />
        </label>
        <label className="mt-2.5 block font-sans text-[13px] text-muted">
          Password
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="current-password" className="w-full border border-rule-strong bg-white p-[7px] font-sans text-[15px] leading-[normal] text-ink" />
        </label>
        <button className={ui.btn()} disabled={busy}>
          Sign in
        </button>
        {error && <div className={ui.note(false)}>{error}</div>}
      </form>
      <p className={`${ui.fine} mb-3`}>
        No account? <Link href="/signup">Sign up</Link>.
      </p>
    </main>
  );
}
