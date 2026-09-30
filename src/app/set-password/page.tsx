import { SetPasswordForm } from './SetPasswordForm';

export const dynamic = 'force-dynamic';

/**
 * Where a password-reset link lands (Better Auth redirects here with
 * `?token=`, or `?error=INVALID_TOKEN`), or the code from the same mail,
 * typed into `ConfirmForm` (`?code=`): choose a password, and be signed in.
 * For an account made by onboarding it is the first password; the "you
 * already have an account" mail sends one of these links to such an account
 * instead of a link to `/signin` (`server/better-auth.ts`).
 */
export default async function SetPassword({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; code?: string; error?: string; email?: string }>;
}) {
  const { token, code, error, email } = await searchParams;
  // A code is only any use with the address it was sent to.
  const proof = error ? null : token ? { token } : code && email ? { code } : null;
  return (
    <main className="mx-auto my-10 max-w-[360px] px-4">
      <h1 className="my-4.5 border-b border-rule pb-1 text-[26px] font-normal">Choose a password</h1>
      <SetPasswordForm proof={proof} email={email ?? null} />
    </main>
  );
}
