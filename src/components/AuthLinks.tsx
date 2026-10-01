'use client';

import Link from 'next/link';
import { Suspense } from 'react';
import { authHref } from '@/lib/return-to';
import { useReturnTo } from './useReturnTo';

function NavLink() {
  const here = useReturnTo();
  return <Link href={authHref('/signin', here)}>sign in</Link>;
}

/** The navbar's one way in, back to this page afterwards. It opens sign-in, which offers the way to sign up. */
export function AuthNavLink() {
  return (
    <Suspense fallback={<Link href="/signin">sign in</Link>}>
      <NavLink />
    </Suspense>
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
