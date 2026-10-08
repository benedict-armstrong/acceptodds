'use client';

import { useEffect } from 'react';
import { rememberVenue } from '@/lib/venue';

/** Remembers the venue the home page was opened on (`VENUE_COOKIE`), so `/welcome` searches it first. */
export function RememberVenue({ kind }: { kind: string }) {
  useEffect(() => rememberVenue(kind), [kind]);
  return null;
}
