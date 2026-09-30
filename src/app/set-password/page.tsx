import { SetPasswordForm } from './SetPasswordForm';

export const dynamic = 'force-dynamic';

/**
 * Where a password-reset link lands (Better Auth redirects here with
 * `?token=`, or `?error=INVALID_TOKEN`): choose a password, and be signed in.
 * For an account made by onboarding it is the first password; the "you
 * already have an account" mail sends one of these links to such an account
 * instead of a link to `/signin` (`server/better-auth.ts`).
 */
export default async function SetPassword({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; error?: string; email?: string }>;
}) {
  const { token, error, email } = await searchParams;
  return (
    <main className="mx-auto my-10 max-w-[360px] px-4">
      <h1 className="my-4.5 border-b border-rule pb-1 text-[26px] font-normal">Choose a password</h1>
      <SetPasswordForm token={error ? null : (token ?? null)} email={email ?? null} />
    </main>
  );
}
