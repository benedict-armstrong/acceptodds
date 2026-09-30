import { AuthTabs } from '@/components/AuthLinks';
import { ui } from '@/components/ui';
import { safeReturnTo } from '@/lib/return-to';
import { allowedInstitutions } from '@/server/institution-domains';
import { SignUpForm } from './SignUpForm';

export const dynamic = 'force-dynamic';

export default async function SignUp({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const next = safeReturnTo((await searchParams).next);
  return (
    <main className="mx-auto my-10 max-w-[360px]">
      <AuthTabs current="/signup" next={next} />
      <p className={`${ui.fine} mb-3`}>Open to email addresses at: {allowedInstitutions().join(', ') || 'no institutions yet'}.</p>
      <SignUpForm next={next} />
    </main>
  );
}
