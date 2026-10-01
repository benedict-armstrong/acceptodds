'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { ui } from '@/components/ui';
import { authClient } from '@/lib/auth-client';
import { signInContinueHref } from '@/lib/links';
import { rememberPending } from '@/lib/pending-confirmation';
import { authHref } from '@/lib/return-to';

/**
 * Email and password, back to `next` afterwards. An unconfirmed address with
 * the right password is not a dead end: Better Auth sends a fresh code and
 * link (`sendOnSignIn`), and this goes on to `/confirm` for it (issue #15).
 *
 * Under it, a sign-in link to the address typed, for anyone without a
 * password or without an account: the link lands on `/signin/continue`,
 * which asks a new account for a name and a password and a passwordless one
 * for a password. The answer is the same whether or not the address has an
 * account.
 */
export function SignInForm({ next }: { next: string }) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [linkSent, setLinkSent] = useState<string | null>(null);
  const emailField = useRef<HTMLInputElement>(null);

  async function sendLink() {
    // Only the address is needed: check that field alone, not the password.
    if (!emailField.current?.reportValidity()) return;
    const address = email.trim();
    setBusy(true);
    setError(null);
    setLinkSent(null);
    const continueTo = signInContinueHref(next);
    const { error } = await authClient.signIn.magicLink({
      email: address,
      callbackURL: continueTo,
      newUserCallbackURL: continueTo,
      errorCallbackURL: continueTo,
    });
    setBusy(false);
    if (error) {
      setError(
        error.code === 'EMAIL_DOMAIN_NOT_ALLOWED'
          ? 'That address is not at an institution on our list.'
          : error.status === 429
            ? 'Too many links to this address. Try again later, or use your password.'
            : (error.message ?? 'Could not send a link.'),
      );
      return;
    }
    setLinkSent(address);
  }

  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        const address = email.trim();
        // `callbackURL` is only for the confirmation mail an unconfirmed sign-in gets.
        const { error } = await authClient.signIn.email({
          email: address,
          password,
          callbackURL: signInContinueHref(next),
        });
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
        <input
          ref={emailField}
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          autoComplete="email"
          className="w-full border border-rule-strong bg-white p-[7px] font-sans text-[15px] leading-[normal] text-ink narrow:text-base"
        />
      </label>
      <label className="mt-2.5 block font-sans text-[13px] text-muted">
        Password
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          autoComplete="current-password"
          className="w-full border border-rule-strong bg-white p-[7px] font-sans text-[15px] leading-[normal] text-ink narrow:text-base"
        />
      </label>
      <button className={ui.btn()} disabled={busy}>
        Sign in
      </button>
      <div className="my-3 text-center font-sans text-[13px] text-faint">or, without a password</div>
      <button type="button" className={ui.btn({ ghost: true })} disabled={busy} onClick={sendLink}>
        Email me a sign-in link
      </button>
      {linkSent && (
        <div className={ui.note(true)}>
          Sent to <b>{linkSent}</b>. Open the link in it to sign in; it works for 15 minutes. No account yet? The link
          makes one.
        </div>
      )}
      {error && <div className={ui.note(false)}>{error}</div>}
    </form>
  );
}
