import { redirect } from 'next/navigation';
import { OnboardingCard } from '@/components/OnboardingCard';
import { ui } from '@/components/ui';
import { MAIL_LINK_TARGETS, type MailLinkTarget } from '@/lib/links';

export const dynamic = 'force-dynamic';

const COPY: Record<MailLinkTarget, { title: string; button: string }> = {
  'magic-link': { title: 'Sign in', button: 'Continue' },
  confirm: { title: 'Confirm your address', button: 'Confirm and sign in' },
};

/**
 * Where a mailed sign-in or confirmation link lands (`lib/links.ts`
 * `mailLinkUrl`). Opening it spends nothing: the sign-in is the button, a
 * GET form to the Better Auth route `?to=` names (a sign-in link without
 * one predates it), with Better Auth's query passed on unchanged. A mail
 * scanner fetching the link never submits it.
 */
export default async function SignInLink({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const to: MailLinkTarget = params.to === 'confirm' ? 'confirm' : 'magic-link';
  if (typeof params.token !== 'string') redirect('/signin');
  const target = MAIL_LINK_TARGETS[to];
  return (
    <OnboardingCard title={COPY[to].title}>
      <form method="get" action={target.action}>
        {target.query.map((key) =>
          typeof params[key] === 'string' ? <input key={key} type="hidden" name={key} value={params[key]} /> : null,
        )}
        <button className={ui.btn()}>{COPY[to].button}</button>
      </form>
    </OnboardingCard>
  );
}
