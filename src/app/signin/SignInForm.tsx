'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ui } from '@/components/ui';
import { authClient } from '@/lib/auth-client';
import { rememberPending } from '@/lib/pending-confirmation';
import { authHref } from '@/lib/return-to';

/**
 * Email and password, back to `next` afterwards. An unconfirmed address with
 * the right password is not a dead end: Better Auth sends a fresh code and
 * link (`sendOnSignIn`), and this goes on to `/confirm` for it (issue #15).
 */
export function SignInForm({ next }: { next: string }) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        const address = email.trim();
        const { error } = await authClient.signIn.email({ email: address, password, callbackURL: next });
        if (error) {
          setBusy(false);
          if (error.code === 'EMAIL_NOT_VERIFIED') {
            rememberPending({ email: address, next });
            router.push(authHref('/confirm', next, { email: address, resent: '1' }));
            return;
          }
          setError(error.message ?? 'Could not sign in.');
          return;
        }
        router.push(next);
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
  );
}
