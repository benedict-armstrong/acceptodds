'use client';

import Link from 'next/link';
import { Suspense } from 'react';
import { authHref } from '@/lib/return-to';
import { useReturnTo } from './useReturnTo';

function Links() {
  const here = useReturnTo();
  return (
    <>
      <Link href={authHref('/signin', here)}>sign in</Link>
      <Link href={authHref('/signup', here)}>sign up</Link>
    </>
  );
}

/** The navbar's sign-in and sign-up links, which bring the person back to this page. */
export function AuthLinks() {
  return (
    <Suspense
      fallback={
        <>
          <Link href="/signin">sign in</Link>
          <Link href="/signup">sign up</Link>
        </>
      }
    >
      <Links />
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
