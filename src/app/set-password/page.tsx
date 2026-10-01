import { headers } from 'next/headers';
import { viewerFromHeaders } from '@/server/auth';
import { resetTokenEmail } from '@/server/better-auth';
import { SetPasswordForm } from './SetPasswordForm';

export const dynamic = 'force-dynamic';

/**
 * Where a password-reset link lands (Better Auth redirects here with
 * `?token=`, or `?error=INVALID_TOKEN`), or the code from the same mail,
 * typed into `ConfirmForm` (`?code=`): choose a password, and be signed in.
 * For an account made by onboarding it is the first password; the "you
 * already have an account" mail sends one of these links to such an account
 * instead of a link to `/signin` (`server/better-auth.ts`).
 *
 * The page names the account whose password it sets, and that is the
 * token's account (`resetTokenEmail`) — `?email=` is only a hint, used for
 * a code (which works only with the address it was sent to) and to resend
 * a dead link. Someone signed in as another account is warned: setting the
 * password signs them in as the link's account instead.
 */
export default async function SetPassword({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; code?: string; error?: string; email?: string }>;
}) {
  const { token, code, error, email } = await searchParams;
  let target: { email: string; proof: { token: string } | { code: string } } | null = null;
  if (!error && token) {
    const owner = await resetTokenEmail(token);
    if (owner) target = { email: owner, proof: { token } };
  } else if (!error && code && email) {
    target = { email, proof: { code } };
  }
  const viewer = await viewerFromHeaders(await headers());
  const signedInAs =
    viewer && target && viewer.email.toLowerCase() !== target.email.toLowerCase() ? viewer.email : null;

  return (
    <main className="mx-auto my-10 max-w-[360px] px-4">
      <h1 className="my-4.5 border-b border-rule pb-1 text-[26px] font-normal">Choose a password</h1>
      <SetPasswordForm target={target} resendTo={target?.email ?? email ?? null} signedInAs={signedInAs} />
    </main>
  );
}
