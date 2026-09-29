import { ui } from '@/components/ui';
import { safeReturnTo } from '@/lib/return-to';
import { allowedInstitutions } from '@/server/institution-domains';
import { SignUpForm } from './SignUpForm';

export const dynamic = 'force-dynamic';

export default async function SignUp({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const next = safeReturnTo((await searchParams).next);
  return (
    <main className="mx-auto my-10 max-w-[360px]">
      <h1 className="my-4.5 text-[26px] font-normal">Sign up</h1>
      <p className={`${ui.fine} mb-3`}>Open to email addresses at: {allowedInstitutions().join(', ') || 'no institutions yet'}.</p>
      <SignUpForm next={next} />
    </main>
  );
}
