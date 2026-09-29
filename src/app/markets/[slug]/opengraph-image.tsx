import { OG_SIZE, previewImage } from '@/server/og';
import { shareSubject } from '@/server/share';

export const alt = 'A market on papermarket: which way it leans';
export const size = OG_SIZE;
export const contentType = 'image/png';
export const dynamic = 'force-dynamic';

/** A market's link preview (issue #11 §1). A listed market's is its paper's. */
export default async function Image({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return previewImage(await shareSubject(decodeURIComponent(slug)));
}
