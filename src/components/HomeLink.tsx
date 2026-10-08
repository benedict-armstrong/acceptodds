'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { useEffect, useSyncExternalStore, type ReactNode } from 'react';

/** This tab's last home-page query string (venue, status, sort, search, page), in `sessionStorage`. */
const KEY = 'home-search';

/** The home page's part: remembers its query string while it is shown, so the logo can return to it. */
export function RememberHomeSearch() {
  const search = useSearchParams().toString();
  useEffect(() => {
    try {
      sessionStorage.setItem(KEY, search);
    } catch {
      // Storage blocked: the logo goes to the plain home page.
    }
  }, [search]);
  return null;
}

/**
 * The logo's link: back to the home page as this tab last left it (its
 * venue, filters, search and page), from anywhere else. On the home page
 * itself it is the plain `/`, so the logo still clears the filters. The
 * server renders `/`, and hydration then reads the stored search.
 */
export function HomeLink({ className, children }: { className?: string; children: ReactNode }) {
  const onHome = usePathname() === '/';
  // Read on every render (each navigation re-renders the header); nothing to subscribe to within a tab.
  const search = useSyncExternalStore(noSubscription, storedSearch, () => '');
  const href = !onHome && search ? `/?${search}` : '/';
  return (
    <Link href={href} aria-label="acceptodds" className={className}>
      {children}
    </Link>
  );
}

function noSubscription(): () => void {
  return () => {};
}

function storedSearch(): string {
  try {
    return sessionStorage.getItem(KEY) ?? '';
  } catch {
    // Storage blocked: the plain home page.
    return '';
  }
}
