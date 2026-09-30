'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ui } from '@/components/ui';
import { rememberPending } from '@/lib/pending-confirmation';
import { authHref } from '@/lib/return-to';

/**
 * Sign-up, then straight on to `/confirm` for the code — never a bare "check
 * your inbox" (issue #15). A name and an email only (`POST /signup`): the
 * password is chosen after confirming, at `/signin/continue`, so nobody can
 * attach one to an address they don't own. `next` is where the person ends
 * up after that.
 */
export function SignUpForm({ next }: { next: string }) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        const address = email.trim();
        const res = await fetch('/api/v1/signup', {
          method: 'POST',
          credentials: 'omit',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name, email: address, next }),
        }).catch(() => null);
        if (!res?.ok) {
          setBusy(false);
          const code = (await res?.json().catch(() => null))?.error?.code;
          setError(
            code === 'email_domain_not_allowed'
              ? 'That address is not at an institution on our list.'
              : code === 'rate_limited'
                ? 'Too many mails to this address today. Try again tomorrow, or use the newest mail.'
                : 'Could not sign up.',
          );
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
      <p className={`${ui.fine} mt-2.5`}>We mail you a link and a code. You choose a password once you have confirmed.</p>
      <button className={ui.btn()} disabled={busy}>
        Sign up
      </button>
      {error && <div className={ui.note(false)}>{error}</div>}
    </form>
  );
}
