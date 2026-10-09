import { cookies } from 'next/headers';
import { defaultMarketKind, VENUE_COOKIE } from '@/lib/venue';

/**
 * The venue a page shows the viewer's wallet and standing in when nothing on
 * the page names one: the one this browser picked last (`VENUE_COOKIE`, on
 * the home page or `/welcome`), else the default. A preference, never a
 * credential: any venue's figures are public.
 */
export async function currentVenue(): Promise<string> {
  const remembered = (await cookies()).get(VENUE_COOKIE)?.value;
  const kind = remembered ? decodeURIComponent(remembered).trim() : '';
  return kind && kind.length <= 100 ? kind : defaultMarketKind();
}
