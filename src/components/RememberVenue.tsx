'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { rememberVenue } from '@/lib/venue';

/**
 * Remembers the venue picked on the home page or `/welcome` (`VENUE_COOKIE`),
 * so `/welcome` searches it first and the navbar's figure (`currentVenue()`)
 * is in it. The root layout is not rendered again on a client navigation, so
 * when the navbar was drawn in another venue (`stale`) the page is refreshed
 * once the cookie is set; the refreshed render reads the new venue and is
 * no longer stale.
 */
export function RememberVenue({ kind, stale }: { kind: string; stale: boolean }) {
  const router = useRouter();
  useEffect(() => {
    rememberVenue(kind);
    if (stale) router.refresh();
  }, [kind, stale, router]);
  return null;
}
