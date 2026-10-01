import { safeReturnTo } from '@/lib/return-to';
import { ConfirmForm } from './ConfirmForm';

export const dynamic = 'force-dynamic';

/** Enter the code from the confirmation mail, in the tab you signed up in (issue #15). */
export default async function Confirm({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const email = typeof sp.email === 'string' ? sp.email : '';
  return (
    <main className="mx-auto my-10 max-w-[360px]">
      <h1 className="my-4.5 text-[26px] font-normal">Confirm your email</h1>
      <ConfirmForm initialEmail={email} next={safeReturnTo(sp.next)} resent={sp.resent === '1'} />
    </main>
  );
}
