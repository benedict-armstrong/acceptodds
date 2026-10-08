import { defaultMarketKind } from '@/lib/venue';
import { homeImage, OG_SIZE } from '@/server/og';
import { venue, venues } from '@/venues';

const home = () => venue(defaultMarketKind()) ?? venues()[0];

export const alt = `acceptodds: ${home().cardTitle.charAt(0).toLowerCase()}${home().cardTitle.slice(1)}`;
export const size = OG_SIZE;
export const contentType = 'image/png';
export const dynamic = 'force-dynamic';

/** The home page's link preview, inherited by every page without its own: the default venue at its prior. */
export default async function Image() {
  return homeImage(home());
}
