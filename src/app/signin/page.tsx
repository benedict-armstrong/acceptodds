import { AuthTabs } from '@/components/AuthLinks';
import { ui } from '@/components/ui';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { welcomeHref, WELCOMED_COOKIE } from '@/lib/onboarding';
import { linkErrorMessage } from '@/lib/link-errors';
import { safeReturnTo } from '@/lib/return-to';
import { viewerFromHeaders } from '@/server/auth';
import { SignInForm } from './SignInForm';

export const dynamic = 'force-dynamic';

export default async function SignIn({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const next = safeReturnTo(params.next);
  // A link from one of our mails that did not work (`lib/link-errors.ts`).
  const linkError = linkErrorMessage(params.error);
  // Already signed in: nothing to do here. On to where signing in would
  // have gone, or to the profile when that is nowhere in particular.
  if (await viewerFromHeaders(await headers())) redirect(next === '/' ? '/profile' : next);
  // First time here: the guided way in (`/welcome`), which links back —
  // unless a link brought them, often in a fresh browser, to say it failed.
  if (!linkError && !(await cookies()).has(WELCOMED_COOKIE)) redirect(welcomeHref(next));
  return (
    <main className="mx-auto my-10 max-w-[360px]">
      <AuthTabs current="/signin" next={next} />
      {linkError && <div className={`${ui.note(false)} mb-3`}>{linkError}</div>}
      <SignInForm next={next} />
    </main>
  );
}
