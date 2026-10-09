'use client';

import { useRouter } from 'next/navigation';
import { rememberVenue } from '@/lib/venue';

/**
 * A venue's name that makes it the navbar's when clicked (§1.8), for a page
 * with no venue of its own: it sets the cookie and draws the page again, as
 * `VenueSwitcher` does there.
 */
export function SwitchVenue({ kind }: { kind: string }) {
  const router = useRouter();
  return (
    <button
      type="button"
      onClick={() => {
        rememberVenue(kind);
        router.refresh();
      }}
      className="cursor-pointer text-left hover:underline"
    >
      {kind}
    </button>
  );
}
