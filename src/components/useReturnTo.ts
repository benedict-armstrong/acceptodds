'use client';

import { usePathname, useSearchParams } from 'next/navigation';

/**
 * The current page as a `?next=` value, for links to sign in or sign up.
 * Uses `useSearchParams`, so its caller must sit inside a `<Suspense>`.
 */
export function useReturnTo(): string {
  const pathname = usePathname();
  const qs = useSearchParams().toString();
  return qs ? `${pathname}?${qs}` : pathname;
}
