'use client';

import Link from 'next/link';
import { Suspense } from 'react';
import { authHref } from '@/lib/return-to';
import { useReturnTo } from './useReturnTo';

function NavLink() {
  const here = useReturnTo();
  return <Link href={authHref('/signin', here)}>sign in</Link>;
}

/**
 * The navbar's one way in, back to this page afterwards. It opens sign-in,
 * whose tabs (`AuthTabs`) offer sign-up.
 */
export function AuthNavLink() {
  return (
    <Suspense fallback={<Link href="/signin">sign in</Link>}>
      <NavLink />
    </Suspense>
  );
}

/**
 * The heading of `/signin` and `/signup`: both as tabs, the current one the
 * page's `h1`, switching between them keeps `next`.
 */
export function AuthTabs({ current, next }: { current: '/signin' | '/signup'; next: string }) {
  const tabs = [
    { page: '/signin', label: 'Sign in' },
    { page: '/signup', label: 'Sign up' },
  ] as const;
  return (
    <div className="my-4.5 flex items-baseline gap-5 border-b border-rule text-[26px]">
      {tabs.map(({ page, label }) =>
        page === current ? (
          <h1 key={page} className="-mb-px border-b-2 border-accent pb-1 font-normal">
            {label}
          </h1>
        ) : (
          <Link key={page} href={authHref(page, next)} className="pb-1 text-muted hover:text-ink hover:no-underline">
            {label}
          </Link>
        ),
      )}
    </div>
  );
}

/** A sign-in link from inside a page (the trade box, the comment form), back to it. */
export function SignInLink({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <Suspense
      fallback={
        <Link href="/signin" className={className}>
          {children}
        </Link>
      }
    >
      <SignInLinkHere className={className}>{children}</SignInLinkHere>
    </Suspense>
  );
}

function SignInLinkHere({ className, children }: { className?: string; children: React.ReactNode }) {
  const here = useReturnTo();
  return (
    <Link href={authHref('/signin', here)} className={className}>
      {children}
    </Link>
  );
}
