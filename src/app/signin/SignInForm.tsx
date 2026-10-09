'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { ui } from '@/components/ui';
import { authClient } from '@/lib/auth-client';
import { hasSubaddress, SUBADDRESS_REFUSED } from '@/lib/email-address';
import { setPasswordPath } from '@/lib/links';
import { rememberPending } from '@/lib/pending-confirmation';
import { track } from '@/lib/track';
import { authHref, VERIFY_EMAIL } from '@/lib/return-to';

/**
 * An email first, and a sign-in link to it: for anyone without a password or
 * without an account (the link makes one), so a new address signs up here
 * too. The password field stays hidden until asked for — invisible, not
 * absent, so a password manager can still fill it: filled, the form turns
 * into a password sign-in, and submitting with a password always signs in
 * with it rather than mailing a link.
 *
 * With a password, back to `next` afterwards. An unconfirmed address with
 * the right password is not a dead end: Better Auth sends a fresh code and
 * link (`sendOnSignIn`), and this goes on to `/verify-email` for it (issue #15).
 *
 * Under it, a sign-in link to the address typed, for anyone without a
 * password or without an account: the link lands on `/verify-email`,
 * which asks a new account for a name and a password and a passwordless one
 * for a password. The answer is the same whether or not the address has an
 * account.
 *
 * "Forgot your password?" mails a reset link to the address typed, to
 * `/set-password`. Better Auth only mails an address with an account, and
 * answers the same either way.
 */
export function SignInForm({ next }: { next: string }) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [linkSent, setLinkSent] = useState<string | null>(null);
  const [resetSent, setResetSent] = useState<string | null>(null);
  const [withPassword, setWithPassword] = useState(false);
  const emailField = useRef<HTMLInputElement>(null);
  const passwordField = useRef<HTMLInputElement>(null);

  // Asked for by "Use a password": focus the field. Filled by a password
  // manager: leave the focus where it is.
  useEffect(() => {
    if (withPassword && !passwordField.current?.value) passwordField.current?.focus();
  }, [withPassword]);

  async function sendLink() {
    // Only the address is needed: check that field alone, not the password.
    if (!emailField.current?.reportValidity()) return;
    const address = email.trim();
    setLinkSent(null);
    setResetSent(null);
    if (hasSubaddress(address)) return setError(SUBADDRESS_REFUSED);
    setBusy(true);
    setError(null);
    const continueTo = authHref(VERIFY_EMAIL, next);
    const { error } = await authClient.signIn.magicLink({
      email: address,
      callbackURL: continueTo,
      newUserCallbackURL: continueTo,
      errorCallbackURL: continueTo,
    });
    setBusy(false);
    if (error) {
      track('signin_link_refused', { reason: String(error.code ?? error.status) });
      setError(
        error.code === 'EMAIL_DOMAIN_NOT_ALLOWED'
          ? 'That address is not at an institution on our list.'
          : error.status === 429
            ? 'Too many links to this address. Try again later, or use your password.'
            : (error.message ?? 'Could not send a link.'),
      );
      return;
    }
    track('signin_link_requested');
    setLinkSent(address);
  }

  async function sendReset() {
    if (!emailField.current?.reportValidity()) return;
    const address = email.trim();
    setLinkSent(null);
    setResetSent(null);
    setBusy(true);
    setError(null);
    const { error } = await authClient.requestPasswordReset({ email: address, redirectTo: setPasswordPath(address) });
    setBusy(false);
    if (error) return setError(error.message ?? 'Could not send a reset link.');
    setResetSent(address);
  }

  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        // Read the field itself: a browser may not report an autofilled
        // password to the page until the submit.
        const password = passwordField.current?.value ?? '';
        if (!password) {
          if (withPassword) return passwordField.current?.reportValidity();
          return sendLink();
        }
        setWithPassword(true);
        setBusy(true);
        setError(null);
        const address = email.trim();
        // `callbackURL` is only for the confirmation mail an unconfirmed sign-in gets.
        const { error } = await authClient.signIn.email({
          email: address,
          password,
          callbackURL: authHref(VERIFY_EMAIL, next),
        });
        if (error) {
          setBusy(false);
          track('signin_failed', { reason: String(error.code ?? error.status) });
          if (error.code === 'EMAIL_NOT_VERIFIED') {
            rememberPending({ email: address, next });
            router.push(authHref(VERIFY_EMAIL, next, { email: address, resent: '1' }));
            return;
          }
          setError(error.message ?? 'Could not sign in.');
          return;
        }
        track('signin_succeeded');
        router.push(next);
        router.refresh();
      }}
      className="relative"
    >
      <label className="mt-2.5 block font-sans text-[13px] text-muted">
        Email
        <input
          ref={emailField}
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          autoComplete="username"
          className="w-full border border-rule-strong bg-white p-[7px] font-sans text-[15px] leading-[normal] text-ink narrow:text-base"
        />
      </label>
      {/* Always rendered so a password manager finds it; until asked for, invisible and out of the flow. */}
      <label
        aria-hidden={!withPassword}
        className={
          withPassword
            ? 'mt-2.5 block font-sans text-[13px] text-muted'
            : 'pointer-events-none absolute inset-x-0 top-0 -z-10 block font-sans text-[13px] text-muted opacity-0'
        }
      >
        Password
        <input
          ref={passwordField}
          type="password"
          value={password}
          onChange={(e) => {
            setPassword(e.target.value);
            if (e.target.value) setWithPassword(true);
          }}
          required={withPassword}
          tabIndex={withPassword ? undefined : -1}
          autoComplete="current-password"
          className="w-full border border-rule-strong bg-white p-[7px] font-sans text-[15px] leading-[normal] text-ink narrow:text-base"
        />
      </label>
      {withPassword ? (
        <>
          <div className="mt-1 text-right font-sans text-[13px]">
            <button
              type="button"
              className="cursor-pointer text-muted hover:underline disabled:cursor-default disabled:opacity-50"
              disabled={busy}
              onClick={sendReset}
            >
              Forgot your password?
            </button>
          </div>
          <button className={ui.btn()} disabled={busy}>
            Sign in
          </button>
          <div className="my-3 text-center font-sans text-[13px] text-faint">or, without a password</div>
          <button type="button" className={ui.btn({ ghost: true })} disabled={busy} onClick={sendLink}>
            Email me a sign-in link
          </button>
        </>
      ) : (
        <>
          <p className={ui.fine}>
            We email you a link that signs you in. No account yet? The same link makes one: just enter your email.
          </p>
          <button className={ui.btn()} disabled={busy}>
            Email me a sign-in link
          </button>
          <div className="my-3 text-center font-sans text-[13px] text-faint">or</div>
          <button
            type="button"
            className={ui.btn({ ghost: true })}
            disabled={busy}
            onClick={() => setWithPassword(true)}
          >
            Use a password
          </button>
        </>
      )}
      {linkSent && (
        <div className={ui.note(true)}>
          Sent to <b>{linkSent}</b>. Open the link in it to sign in; it works for an hour. No account yet? The link
          makes one.
        </div>
      )}
      {resetSent && (
        <div className={ui.note(true)}>
          If <b>{resetSent}</b> has an account, a link to choose a new password is on its way. It works once, for an
          hour.
        </div>
      )}
      {error && <div className={ui.note(false)}>{error}</div>}
    </form>
  );
}
