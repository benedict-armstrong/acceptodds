import { OG_SIZE, previewImage } from '@/server/og';
import { shareSubject } from '@/server/share';

export const alt = 'A paper on papermarket: which way the market leans';
export const size = OG_SIZE;
export const contentType = 'image/png';
export const dynamic = 'force-dynamic';

/** The paper's link preview (issue #11 §1). */
export default async function Image({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return previewImage(await shareSubject(decodeURIComponent(slug)));
}
