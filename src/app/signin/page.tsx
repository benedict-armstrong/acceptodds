import { safeReturnTo } from '@/lib/return-to';
import { SignInForm } from './SignInForm';

export const dynamic = 'force-dynamic';

export default async function SignIn({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const next = safeReturnTo((await searchParams).next);
  return (
    <main className="mx-auto my-10 max-w-[360px]">
      <h1 className="my-4.5 text-[26px] font-normal">Sign in</h1>
      <SignInForm next={next} />
    </main>
  );
}
