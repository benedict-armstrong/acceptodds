'use client';

import { useEffect, useState } from 'react';
import useSWR from 'swr';
import type { z } from 'zod';
import { PaperRow } from '@/components/PaperRow';
import { ui } from '@/components/ui';
import { PAPER_SEARCH_LIMIT } from '@/lib/onboarding';
import type * as S from '@/server/api/schemas';

type Listing = z.output<typeof S.Listing>;
type Market = z.output<typeof S.Market>;

/** Public search is anonymous and does not spend the viewer's rate-limit bucket. */
async function publicJson(url: string) {
  const response = await fetch(url, { credentials: 'omit' });
  if (!response.ok) throw new Error(`Request failed (${response.status})`);
  return response.json();
}

/** A listing can be bet on in onboarding when its main market is open. */
export function tradableListingMarket(l: Listing): Market | null {
  const m = l.markets[0];
  return m && m.status === 'open' && new Date(m.closesAt).getTime() > Date.now() ? m : null;
}

/**
 * Search the venue's papers, with the home page's search box and rows;
 * before anything is typed, the most traded ones. Live as it is typed (Enter
 * only skips the wait), so it has no button, and a row picks rather than navigates.
 */
export function PaperSearch({
  kind,
  suggestions,
  sparks,
  onPick,
}: {
  kind: string;
  suggestions: Listing[];
  /** Sparklines by market id, for the suggestions; a search's results have none. */
  sparks: Record<string, number[]>;
  onPick: (l: Listing) => void;
}) {
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);
  const { data, isLoading } = useSWR<z.output<typeof S.ListingList>>(
    debounced
      ? `/api/v1/listings?kind=${encodeURIComponent(kind)}&q=${encodeURIComponent(debounced)}&limit=${PAPER_SEARCH_LIMIT}`
      : null,
    publicJson,
  );
  const shown = (debounced ? (data?.listings ?? []) : suggestions).filter((l) => tradableListingMarket(l));

  return (
    <>
      <form
        role="search"
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setDebounced(q.trim());
        }}
      >
        <input
          type="search"
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search for a paper"
          aria-label="Search for a paper"
          className={ui.searchInput}
        />
      </form>
      {!debounced && shown.length > 0 && <div className="mt-4 font-sans text-xs text-faint">Most traded</div>}
      <div className={debounced ? 'mt-4' : 'mt-1'}>
        {shown.map((l) => {
          const market = l.markets[0];
          const traded = l.markets.some((m) => m.orderCount > 0);
          return (
            <PaperRow
              key={l.id}
              title={l.title}
              authors={l.authors}
              pdf={l.links.find((link) => link.label.toLowerCase() === 'pdf')}
              market={market}
              volumeMicro={traded ? l.markets.reduce((sum, m) => sum + BigInt(m.volumeMicro), 0n) : null}
              spark={sparks[market.id] ?? []}
              onPick={() => onPick(l)}
            />
          );
        })}
      </div>
      {debounced && !isLoading && shown.length === 0 && <div className={ui.empty}>No open {kind} paper matches.</div>}
    </>
  );
}
