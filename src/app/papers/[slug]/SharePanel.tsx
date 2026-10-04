'use client';

import useSWR from 'swr';
import type { z } from 'zod';
import { CopyButton } from '@/components/CopyButton';
import { CopyField } from '@/components/CopyField';
import { Modal, ModalContent, ModalTrigger } from '@/components/Modal';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/Popover';
import { ShareButton } from '@/components/ShareButtons';
import { MoreIcon, ShareIcon } from '@/components/icons';
import { ui } from '@/components/ui';
import { shareText, shareTitleLine } from '@/lib/headline';
import { marketPollInterval } from '@/lib/market-poll';
import { track } from '@/lib/track';
import type * as S from '@/server/api/schemas';
import { publicJson } from '../../markets/[slug]/MarketLive';

type Market = z.output<typeof S.Market>;

/**
 * "Share" on a paper's page opens a modal with a click-to-copy BibTeX entry
 * (prices, never the viewer's stake) and social share links; the "more" menu beside it
 * shows the embeddable badge with copy buttons for its Markdown and HTML. The
 * text is built from the main market's live prices — the same SWR key and
 * fetcher as `MarketLive`, so no extra polling. Nothing here writes.
 */
export function SharePanel({
  title,
  kind,
  shareUrl,
  badgeUrl,
  initial,
}: {
  title: string;
  kind: string | null;
  /** Absolute `/s/<n>` URL. */
  shareUrl: string;
  /** Absolute `/badge/<slug>.svg` URL. */
  badgeUrl: string;
  /** The main market, as the API presents it. */
  initial: Market;
}) {
  const { data: market = initial } = useSWR<Market>(`/api/v1/markets/${initial.id}`, publicJson, {
    fallbackData: initial,
    refreshInterval: (latest) => marketPollInterval(latest ?? initial),
    revalidateOnMount: false,
  });
  const byOrdinal = [...market.outcomes].sort((a, b) => a.ordinal - b.ordinal);
  const text = shareText({
    title,
    kind,
    url: shareUrl,
    status: market.status,
    prices: byOrdinal.map((o) => o.price),
    year: new Date().getFullYear(),
  });
  const markdown = `[![${kind ?? 'acceptodds'} odds](${badgeUrl})](${shareUrl})`;
  const html = `<a href="${shareUrl}"><img src="${badgeUrl}" alt="${kind ?? 'acceptodds'} odds"></a>`;
  const socialText = shareTitleLine(title, kind, 120);
  const xUrl = `https://x.com/intent/post?${new URLSearchParams({ text: socialText, url: shareUrl })}`;
  const whatsappUrl = `https://wa.me/?${new URLSearchParams({ text: `${socialText}\n${shareUrl}` })}`;

  return (
    <Popover>
      <span className="inline-flex items-center gap-1 font-sans text-[13px]">
        <Modal>
          <ModalTrigger className={`${ui.linkBtn} inline-flex items-center gap-1`}>
            <ShareIcon />
            share
          </ModalTrigger>
          <ModalContent title="Share this paper" wide className="max-h-[calc(100dvh-32px)] overflow-y-auto">
            <CopyField
              multiline
              value={text}
              label="BibTeX entry for this paper"
              className="mb-2"
              onCopied={() => track('share_copied', { target: 'paper' })}
            />
            <div className="flex flex-wrap items-center justify-end gap-2">
              <ShareButton service="x" href={xUrl} />
              <ShareButton service="whatsapp" href={whatsappUrl} />
            </div>
          </ModalContent>
        </Modal>
        <PopoverTrigger
          className="flex cursor-pointer items-center px-1 text-muted hover:text-accent narrow:px-2"
          aria-label="Embeddable badge"
          title="Embeddable badge"
        >
          <MoreIcon />
        </PopoverTrigger>
      </span>
      <PopoverContent>
        <h3 className={ui.boxHeading}>Badge</h3>
        <div className="mb-2">
          {/* eslint-disable-next-line @next/next/no-img-element -- an SVG badge, shown as embedders will see it */}
          <img src={badgeUrl} alt={`${kind ?? 'acceptodds'} odds`} />
        </div>
        <div className="flex flex-wrap gap-x-3 gap-y-1">
          <CopyButton value={markdown} label="Copy Markdown" shareTarget="badge" />
          <CopyButton value={html} label="Copy HTML" shareTarget="badge" />
        </div>
      </PopoverContent>
    </Popover>
  );
}
