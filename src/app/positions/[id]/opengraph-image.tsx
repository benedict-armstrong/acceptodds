import { OG_SIZE, previewImage } from '@/server/og';
import { positionLine, positionSubject } from '@/server/share';
import { loadPublicPosition } from './load';

export const alt = 'A public position on acceptodds: who holds what, and the odds now';
export const size = OG_SIZE;
export const contentType = 'image/png';
export const dynamic = 'force-dynamic';

/** A public position's link preview (#36): the paper's card, with who holds what under the title. */
export default async function Image({ params }: { params: Promise<{ id: string }> }) {
  const p = await loadPublicPosition((await params).id);
  return previewImage(await positionSubject(p), positionLine(p));
}
