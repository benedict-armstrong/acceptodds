import { NextResponse } from 'next/server';
import * as events from '@/server/events';
import { shareSubject } from '@/server/share';

export const dynamic = 'force-dynamic';

/**
 * The short share link, `/s/<slug>` (issue #11): a paper's slug, or an
 * unlisted market's, redirects to its page. A 307 rather than a 308, so the
 * target can move without browsers having cached the old one for good.
 * Crawlers follow it and read the page's own preview metadata. Each open is
 * logged (no payload, no account: the visitor is usually anonymous), which is
 * how the share loop is measured.
 */
export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const subject = await shareSubject(decodeURIComponent(slug));
  if (!subject) return new NextResponse('Not found', { status: 404 });
  events.log('share.opened', { marketId: subject.main?.market.id ?? null });
  return NextResponse.redirect(new URL(subject.path, req.url), 307);
}
