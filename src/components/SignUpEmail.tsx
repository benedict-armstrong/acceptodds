'use client';

import { useState } from 'react';
import { sendSignUp, type SignUpBody } from './signUp';
import { ui } from './ui';

/**
 * The institutional email, sent to `POST /onboarding` (`sendSignUp`) with
 * the rest of `body`: `/welcome`'s last step and a paper's `JevPrice`.
 * `children` sit above the field (what the sign-up is for), `footer` under
 * the button.
 */
export function SignUpEmail({
  body,
  onSent,
  submit,
  autoFocus,
  className,
  children,
  footer,
}: {
  body: Omit<SignUpBody, 'email'>;
  onSent: (email: string) => void;
  /** The button's label. */
  submit: string;
  autoFocus?: boolean;
  className?: string;
  children?: React.ReactNode;
  footer?: React.ReactNode;
}) {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <form
      className={className}
      onSubmit={async (e) => {
        e.preventDefault();
        const address = email.trim();
        setBusy(true);
        setError(null);
        const refused = await sendSignUp({ ...body, email: address });
        setBusy(false);
        if (refused) return setError(refused);
        onSent(address);
      }}
    >
      {children}
      <input
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        required
        autoFocus={autoFocus}
        autoComplete="email"
        placeholder="Institutional email"
        aria-label="Institutional email"
        className={ui.input}
      />
      <button className={ui.btn()} disabled={busy || !email.trim()}>
        {busy ? 'Sending…' : submit}
      </button>
      {error && <div className={ui.note(false)}>{error}</div>}
      {footer}
    </form>
  );
}
