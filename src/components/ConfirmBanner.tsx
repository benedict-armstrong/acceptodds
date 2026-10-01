'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { clearPending, parsePending, readPendingRaw, subscribePending } from '@/lib/pending-confirmation';
import { authHref, VERIFY_EMAIL } from '@/lib/return-to';

const AUTH_PAGES = ['/signin', VERIFY_EMAIL];

/**
 * "Confirm your email" across the site while a sign-up waits for its code
 * (issue #15), so waiting for the mail never means waiting on a page. Read
 * from this browser's storage after mount; gone once anyone is signed in.
 */
export function ConfirmBanner({ signedIn }: { signedIn: boolean }) {
  const pathname = usePathname();
  // Nothing on the server, so the first client render matches it.
  const raw = useSyncExternalStore(subscribePending, readPendingRaw, () => null);
  const pending = useMemo(() => parsePending(raw), [raw]);

  useEffect(() => {
    if (signedIn) clearPending();
  }, [signedIn]);

  if (signedIn || !pending || AUTH_PAGES.includes(pathname)) return null;
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 border-b border-rule bg-highlight px-6 py-2 narrow:px-4 font-sans text-[13px]">
      <span>
        Confirm <b>{pending.email}</b> to start trading: enter the code we emailed you.
      </span>
      <Link href={authHref(VERIFY_EMAIL, pathname, { email: pending.email })} className="font-semibold">
        enter code
      </Link>
      <span className="flex-1" />
      <button className="cursor-pointer text-faint" onClick={clearPending} aria-label="dismiss">
        ×
      </button>
    </div>
  );
}
