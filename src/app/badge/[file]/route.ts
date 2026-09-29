import { renderBadge } from '@/lib/badge';
import { pct } from '@/lib/format';
import { headlineLabel, marketHeadline } from '@/lib/headline';
import { marketLikelihood, type Likelihood } from '@/lib/likelihood';
import * as events from '@/server/events';
import { shareSubject, siteName } from '@/server/share';

export const dynamic = 'force-dynamic';

/** Message colours per likelihood: the `accept` / `reject` tokens, and ink for a toss-up. */
const COLOR: Record<Likelihood | 'none', string> = {
  accept: '#3d7a4f',
  reject: '#a24a3f',
  'toss-up': '#1d1d1d',
  none: '#777',
};

/**
 * The embeddable badge, `/badge/<slug>.svg` (issue #11 §2), for a README or a
 * project page, linking to `/s/<slug>`. A paper's slug, or an unlisted
 * market's. `?style=compact` drops the site name; `?bar=0` drops the bar.
 *
 * Public and anonymous, like the list pages. Cached for five minutes, with an
 * ETag that changes with every fill, so GitHub's image proxy refreshes it.
 * An image, not JSON, so it is not part of `/api/v1` or its OpenAPI contract.
 */
export async function GET(req: Request, { params }: { params: Promise<{ file: string }> }) {
  const { file } = await params;
  const name = decodeURIComponent(file);
  if (!name.endsWith('.svg')) return new Response('Not found', { status: 404 });
  const subject = await shareSubject(name.slice(0, -'.svg'.length));
  if (!subject) return new Response('Not found', { status: 404 });

  const url = new URL(req.url);
  const compact = url.searchParams.get('style') === 'compact';
  const bar = url.searchParams.get('bar') !== '0';
  const main = subject.main;
  const tag = `W/"${main ? `${main.market.id}-${main.market.status}-${main.orderCount}` : 'none'}-${compact ? 'c' : 'f'}${bar ? 'b' : ''}"`;
  const headers = {
    'Content-Type': 'image/svg+xml; charset=utf-8',
    'Cache-Control': 'public, max-age=300, s-maxage=300',
    ETag: tag,
  };
  if (req.headers.get('if-none-match') === tag) return new Response(null, { status: 304, headers });

  let message = 'no market';
  let color = COLOR.none;
  let prices: number[] | null = null;
  if (main) {
    const m = { ...main.market, outcomes: main.outcomes };
    color = COLOR[marketLikelihood(m) ?? 'none'];
    if (main.market.status === 'settled') {
      message = `${main.outcomes.find((o) => o.id === main.market.resolvedOutcomeId)?.label ?? 'settled'} ✓`;
    } else if (main.market.status === 'void') {
      message = 'void';
    } else {
      const h = marketHeadline(m);
      message = `${h === null ? '—' : pct(h)} ${headlineLabel(
        main.outcomes.map((o) => o.label),
        subject.listing !== null,
      )}`;
      if (bar) prices = main.outcomes.map((o) => o.price);
    }
  }
  events.log('badge.read', { marketId: main?.market.id ?? null });
  return new Response(renderBadge({ label: siteName(), message, color, prices, compact }), { headers });
}
