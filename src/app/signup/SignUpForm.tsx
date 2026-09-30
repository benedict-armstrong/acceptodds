'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ui } from '@/components/ui';
import { authClient } from '@/lib/auth-client';
import { rememberPending } from '@/lib/pending-confirmation';
import { authHref } from '@/lib/return-to';

/**
 * Sign-up, then straight on to `/confirm` for the code — never a bare "check
 * your inbox" (issue #15). `next` is where both the code and the mail's link
 * return the person to.
 */
export function SignUpForm({ next }: { next: string }) {
  const router = useRouter();
  const [name, setName] = useState('');
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
        const { error } = await authClient.signUp.email({ name, email: address, password, callbackURL: next });
        if (error) {
          setBusy(false);
          setError(error.message ?? 'Could not sign up.');
          return;
        }
        rememberPending({ email: address, next });
        router.push(authHref('/confirm', next, { email: address }));
      }}
    >
      <label className="mt-2.5 block font-sans text-[13px] text-muted">
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} required autoComplete="name" className="w-full border border-rule-strong bg-white p-[7px] font-sans text-[15px] leading-[normal] text-ink narrow:text-base" />
      </label>
      <label className="mt-2.5 block font-sans text-[13px] text-muted">
        Institutional email
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" className="w-full border border-rule-strong bg-white p-[7px] font-sans text-[15px] leading-[normal] text-ink narrow:text-base" />
      </label>
      <label className="mt-2.5 block font-sans text-[13px] text-muted">
        Password (12+ characters)
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={12} autoComplete="new-password" className="w-full border border-rule-strong bg-white p-[7px] font-sans text-[15px] leading-[normal] text-ink narrow:text-base" />
      </label>
      <button className={ui.btn()} disabled={busy}>
        Sign up
      </button>
      {error && <div className={ui.note(false)}>{error}</div>}
    </form>
  );
}
