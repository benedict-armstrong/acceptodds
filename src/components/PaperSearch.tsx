'use client';

import { useEffect, useState } from 'react';
import useSWR from 'swr';
import type { z } from 'zod';
import { MathText } from '@/components/MathText';
import { ui } from '@/components/ui';
import { pct } from '@/lib/format';
import { marketHeadline } from '@/lib/headline';
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

/** Search the venue's papers; before anything is typed, the most traded ones. */
export function PaperSearch({
  kind,
  suggestions,
  onPick,
}: {
  kind: string;
  suggestions: Listing[];
  onPick: (l: Listing) => void;
}) {
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);
  const { data, isLoading } = useSWR<z.output<typeof S.ListingList>>(
    debounced ? `/api/v1/listings?kind=${encodeURIComponent(kind)}&q=${encodeURIComponent(debounced)}&limit=8` : null,
    publicJson,
  );
  const shown = (debounced ? (data?.listings ?? []) : suggestions).filter((l) => tradableListingMarket(l));

  return (
    <>
      <input
        autoFocus
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Title or author"
        aria-label="Search papers"
        className={ui.input}
      />
      {!debounced && shown.length > 0 && <div className="mt-2 text-xs text-faint">Most traded</div>}
      <ul className="mt-1">
        {shown.map((l) => {
          const h = marketHeadline(l.markets[0]);
          return (
            <li key={l.id}>
              <button
                className="flex w-full cursor-pointer items-baseline gap-3 border-b border-rule-soft py-2 text-left hover:text-accent"
                onClick={() => onPick(l)}
              >
                <span className="min-w-0 flex-1 truncate">
                  <MathText text={l.title} />
                </span>
                {h !== null && <span className="font-mono text-[13px] text-muted">{pct(h)}</span>}
              </button>
            </li>
          );
        })}
      </ul>
      {debounced && !isLoading && shown.length === 0 && <div className={ui.empty}>No open {kind} paper matches.</div>}
    </>
  );
}
