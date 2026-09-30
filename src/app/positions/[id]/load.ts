import { notFound } from 'next/navigation';
import { ApiError } from '@/server/api/errors';
import { publicPosition } from '@/server/public-positions';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A public position by its link id, or the 404 page: malformed, never made public, or made private since. */
export async function loadPublicPosition(id: string) {
  if (!UUID.test(id)) notFound();
  try {
    return await publicPosition(id);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound();
    throw err;
  }
}
