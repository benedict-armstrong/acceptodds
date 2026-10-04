'use client';

import { useEffect, useState } from 'react';

/** The paper this tab showed last, for `?from=`: after this long, the next paper is not "next". */
const LAST_PAPER_KEY = 'pm:lastPaper';
const LAST_PAPER_MS = 30 * 60_000;

interface LastPaper {
  id: string;
  /** The paper before it, kept so a reload (or React re-running the effect) sends the same pair. */
  from: string | null;
  at: number;
}

/**
 * The paper read just before this one in this tab, and remember this one.
 * `sessionStorage`, so per tab and gone with it; `document.referrer` would
 * not do, as a client-side navigation leaves it unchanged.
 */
function previousPaper(listingId: string): string | null {
  try {
    const raw = sessionStorage.getItem(LAST_PAPER_KEY);
    const last = raw ? (JSON.parse(raw) as LastPaper) : null;
    const now = Date.now();
    let from: string | null = null;
    if (last && now - last.at < LAST_PAPER_MS) from = last.id === listingId ? last.from : last.id;
    sessionStorage.setItem(LAST_PAPER_KEY, JSON.stringify({ id: listingId, from, at: now } satisfies LastPaper));
    return from;
  } catch {
    return null;
  }
}

/**
 * A paper's unique viewers, counted from the browser (`POST
 * /api/v1/listings/{id}/view`) so a page served from Cloudflare's cache still
 * counts and a crawler that runs no script does not. Sent with the session
 * cookie, so a signed-in viewer counts as their account rather than as their
 * network (one unit of their rate-limit bucket). Shows the count the server
 * rendered, then the one the beacon returns. Also names the paper this tab
 * showed before (`?from=`), which the server keeps only as a total per pair.
 */
export function ViewCount({ listingId, views: initial }: { listingId: string; views: number }) {
  const [views, setViews] = useState(initial);

  useEffect(() => {
    const abort = new AbortController();
    const from = previousPaper(listingId);
    const query = from ? `?from=${encodeURIComponent(from)}` : '';
    fetch(`/api/v1/listings/${listingId}/view${query}`, {
      method: 'POST',
      credentials: 'same-origin',
      signal: abort.signal,
    })
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
