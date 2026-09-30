import { AuthTabs } from '@/components/AuthLinks';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { welcomeHref, WELCOMED_COOKIE } from '@/lib/onboarding';
import { safeReturnTo } from '@/lib/return-to';
import { viewerFromHeaders } from '@/server/auth';
import { SignInForm } from './SignInForm';

export const dynamic = 'force-dynamic';

export default async function SignIn({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const next = safeReturnTo((await searchParams).next);
  // Already signed in: nothing to do here. On to where signing in would
  // have gone, or to the profile when that is nowhere in particular.
  if (await viewerFromHeaders(await headers())) redirect(next === '/' ? '/profile' : next);
  // First time here: the guided way in (`/welcome`), which links back.
  if (!(await cookies()).has(WELCOMED_COOKIE)) redirect(welcomeHref(next));
  return (
    <main className="mx-auto my-10 max-w-[360px]">
      <AuthTabs current="/signin" next={next} />
      <SignInForm next={next} />
    </main>
  );
}
