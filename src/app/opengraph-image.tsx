import { defaultMarketKind } from '@/lib/venue';
import { marketTemplate } from '@/server/market-templates';
import { homeImage, OG_SIZE } from '@/server/og';

export const alt = 'acceptodds: which papers will get accepted?';
export const size = OG_SIZE;
export const contentType = 'image/png';
export const dynamic = 'force-dynamic';

/** The home page's link preview, inherited by every page without its own: the default venue at its prior. */
export default async function Image() {
  const kind = defaultMarketKind();
  const t = marketTemplate(kind);
  return homeImage(kind, t && t.outcomes.map((label, i) => ({ label, price: t.fallbackPrices[i] })));
}
