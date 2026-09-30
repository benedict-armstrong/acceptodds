import { AuthTabs } from '@/components/AuthLinks';
import { ui } from '@/components/ui';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { welcomeHref, WELCOMED_COOKIE } from '@/lib/onboarding';
import { safeReturnTo } from '@/lib/return-to';
import { allowedInstitutionCount } from '@/server/institution-domains';
import { SignUpForm } from './SignUpForm';

export const dynamic = 'force-dynamic';

export default async function SignUp({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const next = safeReturnTo((await searchParams).next);
  // First time here: the guided way in (`/welcome`), which links back.
  if (!(await cookies()).has(WELCOMED_COOKIE)) redirect(welcomeHref(next));
  return (
    <main className="mx-auto my-10 max-w-[360px]">
      <AuthTabs current="/signup" next={next} />
      <p className={`${ui.fine} mb-3`}>
        Open to email addresses at {allowedInstitutionCount().toLocaleString('en-US')} universities, research institutes
        and research labs.
      </p>
      <SignUpForm next={next} />
    </main>
  );
}
