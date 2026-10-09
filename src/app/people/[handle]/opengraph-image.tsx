import { fieldSnapshot } from '@/server/field-snapshot';
import { OG_SIZE, profileImage } from '@/server/og';
import { loadPerson } from './load';

export const alt = 'A trader on acceptodds: where they stand among all traders';
export const size = OG_SIZE;
export const contentType = 'image/png';
export const dynamic = 'force-dynamic';

/** A trader's link preview: their rank, and the field's curve with them on it, as their page's Figure 1. */
export default async function Image({ params }: { params: Promise<{ handle: string }> }) {
  const { account: a, kind, row, standing } = await loadPerson((await params).handle);
  return profileImage({
    displayName: a.displayName,
    handle: a.handle,
    institutions: a.institutions,
    standing,
    field: await fieldSnapshot(kind),
    worthMicro: row?.netWorthMicro ?? null,
  });
}
