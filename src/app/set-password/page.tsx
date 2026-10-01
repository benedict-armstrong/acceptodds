import { headers } from 'next/headers';
import { viewerFromHeaders } from '@/server/auth';
import { resetTokenEmail } from '@/server/better-auth';
import { SetPasswordForm } from './SetPasswordForm';

export const dynamic = 'force-dynamic';

/**
 * Where a password-reset link lands (Better Auth redirects here with
 * `?token=`, or `?error=INVALID_TOKEN`): choose a password, and be signed
 * in. For an account made by onboarding that has none it is the first
 * password.
 *
 * The page names the account whose password it sets, and that is the
 * token's account (`resetTokenEmail`) — `?email=` is only a hint, used to
 * resend a dead link. Someone signed in as another account is warned:
 * setting the password signs them in as the link's account instead.
 */
export default async function SetPassword({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; error?: string; email?: string }>;
}) {
  const { token, error, email } = await searchParams;
  let target: { email: string; token: string } | null = null;
  if (!error && token) {
    const owner = await resetTokenEmail(token);
    if (owner) target = { email: owner, token };
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
