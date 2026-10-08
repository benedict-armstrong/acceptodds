'use client';

import { useEffect, useState, type ReactNode } from 'react';
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
 * A paper with no market yet is offered too when `canOpen`: picking it is
 * what opens its market (`POST /listings/{id}/market`).
 */
export function PaperSearch({
  kind,
  suggestions,
  sparks,
  canOpen,
  below,
  onPick,
}: {
  kind: string;
  suggestions: Listing[];
  /** Sparklines by market id, for the suggestions; a search's results have none. */
  sparks: Record<string, number[]>;
  /** Whether the viewer may open a paper's market: its kind's template is open, and they may trade or are signed out. */
  canOpen: boolean;
  /** Set under the search bar, above the papers (`/welcome`'s venue choice). */
  below?: ReactNode;
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
  const shown = (debounced ? (data?.listings ?? []) : suggestions).filter(
    (l) => tradableListingMarket(l) || (canOpen && l.markets.length === 0),
  );

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
      {below}
      {!debounced && shown.length > 0 && <div className="mt-4 font-sans text-xs text-faint">Most traded</div>}
      <div className={debounced ? 'mt-4' : 'mt-1'}>
        {shown.map((l) => {
          const traded = l.markets.some((m) => m.orderCount > 0);
          // No price before the first trade: an untraded market's is only JEV's.
          const main = l.markets.at(0);
          const market = main && main.orderCount > 0 ? main : null;
          return (
            <PaperRow
              key={l.id}
              title={l.title}
              authors={l.authors}
              pdf={l.links.find((link) => link.label.toLowerCase() === 'pdf')}
              market={market}
              volumeMicro={traded ? l.markets.reduce((sum, m) => sum + BigInt(m.volumeMicro), 0n) : null}
              spark={market ? (sparks[market.id] ?? []) : []}
              onPick={() => onPick(l)}
            />
          );
        })}
      </div>
      {debounced && !isLoading && shown.length === 0 && <div className={ui.empty}>No open {kind} paper matches.</div>}
    </>
  );
}
