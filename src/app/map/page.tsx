import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { PaperMapView } from '@/components/map/PaperMapView';
import { viewerFromHeaders } from '@/server/auth';

export const metadata: Metadata = {
  title: 'Map of papers | acceptodds',
  description: 'Every paper on one map, placed near the papers most like it, coloured by topic or by its odds.',
  alternates: { canonical: '/map' },
};

/**
 * The paper map, full screen under the navbar. Nothing but the map: it is
 * fetched by the client from `GET /api/v1/map` (tens of thousands of points
 * are too many to put in the HTML) and drawn in WebGL.
 */
export default async function MapPage() {
  // Only whether there is a viewer: the client then fetches their stars and holdings itself.
  const viewer = await viewerFromHeaders(await headers());
  return (
    <main>
      <PaperMapView signedIn={viewer !== null} />
    </main>
  );
}
