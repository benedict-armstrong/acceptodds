'use client';

import { useState } from 'react';
import useSWR from 'swr';
import type { z } from 'zod';
import { ui } from '@/components/ui';
import { shareText } from '@/lib/headline';
import type * as S from '@/server/api/schemas';
import { publicJson, viewerJson } from '../../markets/[slug]/MarketLive';

type Market = z.output<typeof S.Market>;
type Portfolio = z.output<typeof S.Portfolio>;

/**
 * "Share" on a paper's page (issue #11 §2–3): the Wordle-style text share,
 * the embeddable badge and the short link, each with a copy button. The text
 * is built from the main market's live prices — the same SWR keys and
 * fetchers as `MarketLive`, so no extra polling — and, while the viewer holds
 * shares in it, can carry their side ("I'm 🟩. You?"): the outcome they hold
 * most of, never a size or a value (§1.1). Nothing here writes.
 */
export function SharePanel({
  title,
  kind,
  shareUrl,
  badgeUrl,
  initial,
  signedIn,
}: {
  title: string;
  kind: string | null;
  /** Absolute `/s/<slug>` URL. */
  shareUrl: string;
  /** Absolute `/badge/<slug>.svg` URL. */
  badgeUrl: string;
  /** The main market, as the API presents it. */
  initial: Market;
  signedIn: boolean;
}) {
  const { data: market = initial } = useSWR<Market>(`/api/v1/markets/${initial.id}`, publicJson, {
    fallbackData: initial,
    refreshInterval: 3000,
  });
  const { data: portfolio } = useSWR<Portfolio | null>(signedIn ? '/api/v1/me/portfolio' : null, viewerJson, {
    refreshInterval: 6000,
  });

  const [name, setName] = useState(title.replace(/\$/g, ''));
  const [mine, setMine] = useState(true);

  // The outcome the viewer holds most shares of in this market, if any.
  const held = (portfolio?.holdings ?? [])
    .filter((h) => h.marketId === market.id && BigInt(h.sharesMicro) > 0n)
    .sort((a, b) => (BigInt(b.sharesMicro) > BigInt(a.sharesMicro) ? 1 : -1))[0];
  const heldOrdinal = held ? (market.outcomes.find((o) => o.id === held.outcomeId)?.ordinal ?? null) : null;

  const byOrdinal = [...market.outcomes].sort((a, b) => a.ordinal - b.ordinal);
  const text = shareText({
    title: name.trim() || title,
    kind,
    url: shareUrl,
    status: market.status,
    prices: byOrdinal.map((o) => o.price),
    heldOrdinal: mine ? heldOrdinal : null,
  });
  const markdown = `[![${kind ?? 'acceptodds'} odds](${badgeUrl})](${shareUrl})`;
  const html = `<a href="${shareUrl}"><img src="${badgeUrl}" alt="${kind ?? 'acceptodds'} odds"></a>`;

  return (
    <details className="group relative">
      <summary className="cursor-pointer list-none font-sans text-[13px] text-accent [&::-webkit-details-marker]:hidden">
        share
      </summary>
      <div className="absolute left-1/2 z-10 mt-2 w-[min(460px,calc(100vw-32px))] -translate-x-1/2 border border-frame bg-card p-3.5 text-left font-sans text-sm shadow-sm">
        <h3 className={ui.sectionHeading}>Share</h3>
        <label className="mb-1 block text-xs text-muted" htmlFor="share-name">
          Short name
        </label>
        <input id="share-name" className={ui.input} value={name} onChange={(e) => setName(e.target.value)} />
        <pre className="mb-2 overflow-x-auto border border-rule bg-bg p-2.5 font-mono text-[13px] leading-snug whitespace-pre">
          {text}
        </pre>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <Copy value={text} label="Copy text" />
          {heldOrdinal !== null && (
            <label className="flex items-center gap-1.5 text-[13px] text-muted">
              <input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} />
              include my side
            </label>
          )}
        </div>

        <h3 className={`${ui.sectionHeading} mt-4`}>Badge</h3>
        <div className="mb-2">
          {/* eslint-disable-next-line @next/next/no-img-element -- an SVG badge, shown as embedders will see it */}
          <img src={badgeUrl} alt={`${kind ?? 'acceptodds'} odds`} />
        </div>
        <div className="flex flex-wrap gap-x-3 gap-y-1">
          <Copy value={markdown} label="Copy Markdown" />
          <Copy value={html} label="Copy HTML" />
        </div>

        <h3 className={`${ui.sectionHeading} mt-4`}>Link</h3>
        <div className="flex items-center gap-3">
          <code className="min-w-0 truncate font-mono text-[13px]">{shareUrl}</code>
          <Copy value={shareUrl} label="Copy" />
        </div>
      </div>
    </details>
  );
}

function Copy({ value, label }: { value: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className={ui.btn({ ghost: true, inline: true })}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          /* no clipboard (insecure context): the text is on screen to copy by hand */
        }
      }}
    >
      {done ? 'Copied' : label}
    </button>
  );
}
