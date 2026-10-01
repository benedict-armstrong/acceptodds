import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { LINK_USED } from '@/lib/link-errors';
import { WELCOME_FINISH } from '@/lib/onboarding';
import { authHref, safeReturnTo } from '@/lib/return-to';
import { viewerFromHeaders } from '@/server/auth';
import { missingFromUser } from '@/server/better-auth';
import { pendingBetFor } from '@/server/onboarding';
import { ContinueForm } from './ContinueForm';

export const dynamic = 'force-dynamic';

/**
 * Where every sign-in link lands (`lib/links.ts` `signInContinueHref`),
 * signed in by it. A dead link (`?error=`), or one opened again (no
 * session), goes on to `/signin`, which says what went wrong. It asks
 * for what the account still lacks: a new one (made by the link) a name and
 * a password, one without a password (made by onboarding) a password. The
 * session decides whose account that is, and the page says so. With nothing
 * missing it goes straight on to `next`; with an onboarding bet waiting, to
 * `/welcome`'s last step, which places it.
 */
export default async function SignInContinue({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const params = await searchParams;
  const next = safeReturnTo(params.next);
  if (params.error) redirect(authHref('/signin', next, { error: params.error }));

  const viewer = await viewerFromHeaders(await headers());
  if (!viewer?.account.userId) redirect(authHref('/signin', next, { error: LINK_USED }));
  const userId = viewer.account.userId;
  if (await pendingBetFor(userId)) redirect(WELCOME_FINISH);
  const missing = await missingFromUser(userId);
  if (!missing.name && !missing.password) redirect(next);

  return (
    <main className="mx-auto my-10 max-w-[360px] px-4">
      <h1 className="my-4.5 border-b border-rule pb-1 text-[26px] font-normal">
        {missing.name ? 'Finish signing up' : 'Choose a password'}
      </h1>
      <ContinueForm email={viewer.email} needsName={missing.name} needsPassword={missing.password} next={next} />
    </main>
  );
}
