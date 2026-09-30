import Link from 'next/link';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { ui } from '@/components/ui';
import { WELCOME_FINISH } from '@/lib/onboarding';
import { authHref, safeReturnTo } from '@/lib/return-to';
import { viewerFromHeaders } from '@/server/auth';
import { missingFromUser } from '@/server/better-auth';
import { pendingBetFor } from '@/server/onboarding';
import { ContinueForm } from './ContinueForm';

export const dynamic = 'force-dynamic';

const LINK_ERRORS: Record<string, string> = {
  INVALID_TOKEN: 'This sign-in link has expired or was already used.',
  EXPIRED_TOKEN: 'This sign-in link has expired.',
  EMAIL_DOMAIN_NOT_ALLOWED: 'That address is not at an institution on our list.',
};

/**
 * Where every sign-in link lands (`lib/links.ts` `signInContinueHref`),
 * signed in by it — or back with `?error=` when the link was dead. It asks
 * for what the account still lacks: a new one (made by the link) a name and
 * a password, one without a password (made by onboarding) a password. The
 * session decides whose account that is, and the page says so. With nothing
 * missing it goes straight on to `next`; with an onboarding bet waiting, to
 * `/welcome`'s last step, which places it.
 */
export default async function SignInContinue({ searchParams }: { searchParams: Promise<{ next?: string; error?: string }> }) {
  const params = await searchParams;
  const next = safeReturnTo(params.next);
  if (params.error) {
    return (
      <main className="mx-auto my-10 max-w-[360px] px-4">
        <h1 className="my-4.5 border-b border-rule pb-1 text-[26px] font-normal">Sign in</h1>
        <p className="mb-3">{LINK_ERRORS[params.error] ?? 'That sign-in link did not work.'}</p>
        <Link href={authHref('/signin', next)} className={ui.btn()}>
          Sign in again
        </Link>
      </main>
    );
  }

  const viewer = await viewerFromHeaders(await headers());
  if (!viewer?.account.userId) redirect(authHref('/signin', next));
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
