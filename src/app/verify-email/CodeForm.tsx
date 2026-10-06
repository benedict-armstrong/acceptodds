'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { CodeEntry } from '@/components/CodeEntry';
import { ui } from '@/components/ui';
import { authClient } from '@/lib/auth-client';
import { clearPending, rememberPending } from '@/lib/pending-confirmation';
import { authHref, VERIFY_EMAIL } from '@/lib/return-to';
import { welcomeHref } from '@/lib/onboarding';

const field =
  'w-full border border-rule-strong bg-white p-[7px] font-sans text-[15px] leading-[normal] text-ink narrow:text-base';

/**
 * The code from the confirmation mail, typed where the person already is.
 * Confirming creates the trader and signs in (Better Auth's
 * `autoSignInAfterVerification`); the page then re-renders signed in and
 * asks for whatever the account still lacks (`Finish`). The link in the same
 * mail does the same from any browser.
 */
export function CodeForm({ initialEmail, next, resent }: { initialEmail: string; next: string; resent: boolean }) {
  const router = useRouter();
  const [email, setEmail] = useState(initialEmail);

  useEffect(() => {
    if (initialEmail) rememberPending({ email: initialEmail, next });
  }, [initialEmail, next]);

  async function resend(): Promise<string | null> {
    const address = email.trim();
    const { error } = await authClient.sendVerificationEmail({
      email: address,
      callbackURL: authHref(VERIFY_EMAIL, next),
    });
    if (error) return error.message ?? 'Could not send a new code.';
    rememberPending({ email: address, next });
    return null;
  }

  return (
    <>
      <p className="my-4">
        {initialEmail ? (
          <>
            We sent a 6-digit code and a link to <b>{initialEmail}</b>. Enter the code here, or open the link. If you
            have no account yet, it and your starting balance are created when you confirm.
          </>
        ) : (
          <>Enter your email and the 6-digit code from the confirmation mail.</>
        )}
      </p>
      {!initialEmail && (
        <label className="mt-2.5 block font-sans text-[13px] text-muted">
          Email
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoComplete="email"
            className={field}
          />
        </label>
      )}
      <div className="mt-2.5 text-center font-sans text-[13px] text-muted">Code</div>
      <CodeEntry
        email={email.trim()}
        onConfirmed={() => {
          clearPending();
          router.refresh();
        }}
        resend={resend}
        autoFocus={!!initialEmail}
        initialNote={resent ? 'We sent you a new code.' : null}
        footer={
          <>
            Wrong address? <Link href={welcomeHref(next)}>Start again</Link>.
          </>
        }
      />
      <p className={`${ui.fine} mb-3`}>
        <Link href={next}>Keep browsing</Link> while you wait; you can come back here from the banner at the top.
      </p>
    </>
  );
}
