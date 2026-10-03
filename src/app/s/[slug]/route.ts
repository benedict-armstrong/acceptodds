import { NextResponse } from 'next/server';
import * as events from '@/server/events';
import { shareSubject, siteUrl } from '@/server/share';

export const dynamic = 'force-dynamic';

/**
 * The short share link, `/s/<n>` (issue #11): a paper's `short_id`, or an
 * unlisted market's, redirects to its page. A slug still resolves, so a link
 * shared before short ids keeps working. A 307 rather than a 308, so the
 * target can move without browsers having cached the old one for good.
 * Crawlers follow it and read the page's own preview metadata. Each open is
 * logged (no payload, no account: the visitor is usually anonymous), which is
 * how the share loop is measured.
 *
 * The target is built on `siteUrl()`, never `req.url`: behind the proxy the
 * standalone server sees its own bind address (`HOSTNAME=0.0.0.0`), and a
 * redirect built from that sends the visitor to http://0.0.0.0:3000.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const subject = await shareSubject(decodeURIComponent(slug));
  if (!subject) return new NextResponse('Not found', { status: 404 });
  events.log('share.opened', { marketId: subject.main?.market.id ?? null });
  return NextResponse.redirect(new URL(subject.path, siteUrl()), 307);
}
