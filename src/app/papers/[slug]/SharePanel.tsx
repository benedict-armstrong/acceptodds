'use client';

import { useState } from 'react';
import useSWR from 'swr';
import type { z } from 'zod';
import { CopyButton } from '@/components/CopyButton';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/Popover';
import { MoreIcon, ShareIcon } from '@/components/icons';
import { ui } from '@/components/ui';
import { shareText } from '@/lib/headline';
import type * as S from '@/server/api/schemas';
import { publicJson, viewerJson } from '../../markets/[slug]/MarketLive';

type Market = z.output<typeof S.Market>;
type Portfolio = z.output<typeof S.Portfolio>;

/**
 * "Share" on a paper's page (issues #11 §2–3, #18). Clicking "share" copies
 * the Wordle-style text, without the viewer's stake; the "more" menu beside it
 * has a short-name field, the embeddable badge and the short link, each with
 * a copy button. The text is built from the main market's live prices — the
 * same SWR keys and fetchers as `MarketLive`, so no extra polling — and,
 * while the viewer holds shares in it, the menu can opt in to their side
 * ("I'm 🟩. You?"): the outcome they hold most of, never a size or a value
 * (§1.1). Nothing here writes.
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
  const [mine, setMine] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  // The outcome the viewer holds most shares of in this market, if any.
  const held = (portfolio?.holdings ?? [])
    .filter((h) => h.marketId === market.id && BigInt(h.sharesMicro) > 0n)
    .sort((a, b) => (BigInt(b.sharesMicro) > BigInt(a.sharesMicro) ? 1 : -1))[0];
  const heldOrdinal = held ? (market.outcomes.find((o) => o.id === held.outcomeId)?.ordinal ?? null) : null;

  const byOrdinal = [...market.outcomes].sort((a, b) => a.ordinal - b.ordinal);
  const textFor = (side: number | null) =>
    shareText({
      title: name.trim() || title,
      kind,
      url: shareUrl,
      status: market.status,
      prices: byOrdinal.map((o) => o.price),
      heldOrdinal: side,
    });
  // The one-click share never carries a stake; "include my side" is opt-in, in the menu.
  const plain = textFor(null);
  const text = textFor(mine ? heldOrdinal : null);
  const markdown = `[![${kind ?? 'acceptodds'} odds](${badgeUrl})](${shareUrl})`;
  const html = `<a href="${shareUrl}"><img src="${badgeUrl}" alt="${kind ?? 'acceptodds'} odds"></a>`;

  return (
    <Popover open={menuOpen} onOpenChange={setMenuOpen}>
      <span className="inline-flex items-center gap-1 font-sans text-[13px]">
        <CopyButton
          value={plain}
          label={
            <span className="inline-flex items-center gap-1">
              <ShareIcon />
              share
            </span>
          }
          copied="copied"
          className={ui.linkBtn}
          title="Copy the share text"
          onFail={() => setMenuOpen(true)} // no clipboard: the text is in the menu to copy by hand
        />
        <PopoverTrigger
          className="flex cursor-pointer items-center px-1 text-muted hover:text-accent"
          aria-label="More ways to share"
          title="More ways to share"
        >
          <MoreIcon />
        </PopoverTrigger>
      </span>
      <PopoverContent>
        <h3 className={ui.boxHeading}>Share</h3>
        <label className="mb-1 block text-xs text-muted" htmlFor="share-name">
          Short name
        </label>
        <input id="share-name" className={ui.input} value={name} onChange={(e) => setName(e.target.value)} />
        <pre className="mb-2 overflow-x-auto border border-rule bg-bg p-2.5 font-mono text-[13px] leading-snug whitespace-pre">
          {text}
        </pre>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <CopyButton value={text} label="Copy text" />
          {heldOrdinal !== null && (
            <label className="flex items-center gap-1.5 text-[13px] text-muted">
              <input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} />
              include my side
            </label>
          )}
        </div>

        <h3 className={`${ui.boxHeading} mt-4`}>Badge</h3>
        <div className="mb-2">
          {/* eslint-disable-next-line @next/next/no-img-element -- an SVG badge, shown as embedders will see it */}
          <img src={badgeUrl} alt={`${kind ?? 'acceptodds'} odds`} />
        </div>
        <div className="flex flex-wrap gap-x-3 gap-y-1">
          <CopyButton value={markdown} label="Copy Markdown" />
          <CopyButton value={html} label="Copy HTML" />
        </div>

        <h3 className={`${ui.boxHeading} mt-4`}>Link</h3>
        <div className="flex items-center gap-3">
          <code className="min-w-0 truncate font-mono text-[13px]">{shareUrl}</code>
          <CopyButton value={shareUrl} label="Copy" />
        </div>
      </PopoverContent>
    </Popover>
  );
}
