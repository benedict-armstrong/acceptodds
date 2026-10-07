import { redirect } from 'next/navigation';
import { OnboardingCard } from '@/components/OnboardingCard';
import { ui } from '@/components/ui';

export const dynamic = 'force-dynamic';

/** The query Better Auth puts on a sign-in link, passed on to its verify route unchanged. */
const PASSED_ON = ['token', 'callbackURL', 'newUserCallbackURL', 'errorCallbackURL'] as const;

/**
 * Where a mailed sign-in link lands (`lib/links.ts` `signInLinkUrl`). Opening
 * it spends nothing: the sign-in is the button, a GET form to Better Auth's
 * `/magic-link/verify`, which a mail scanner fetching the link never submits.
 */
export default async function SignInLink({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  if (typeof params.token !== 'string') redirect('/signin');
  return (
    <OnboardingCard title="Sign in">
      <form method="get" action="/api/auth/magic-link/verify">
        {PASSED_ON.map((key) =>
          typeof params[key] === 'string' ? <input key={key} type="hidden" name={key} value={params[key]} /> : null,
        )}
        <button className={ui.btn()}>Continue</button>
      </form>
    </OnboardingCard>
  );
}
