'use client';

import { useEffect, useState } from 'react';

/**
 * A paper's unique viewers, counted from the browser (`POST
 * /api/v1/listings/{id}/view`) so a page served from Cloudflare's cache still
 * counts and a crawler that runs no script does not. Sent with the session
 * cookie, so a signed-in viewer counts as their account rather than as their
 * network (one unit of their rate-limit bucket). Shows the count the server
 * rendered, then the one the beacon returns.
 */
export function ViewCount({ listingId, views: initial }: { listingId: string; views: number }) {
  const [views, setViews] = useState(initial);

  useEffect(() => {
    const abort = new AbortController();
    fetch(`/api/v1/listings/${listingId}/view`, { method: 'POST', credentials: 'same-origin', signal: abort.signal })
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { views?: number } | null) => {
        if (typeof body?.views === 'number') setViews(body.views);
      })
      .catch(() => {});
    return () => abort.abort();
  }, [listingId]);

  return (
    <span className="font-sans text-[13px] text-muted">
      <span className="font-mono">{views.toLocaleString('en-US')}</span> {views === 1 ? 'view' : 'views'}
    </span>
  );
}
