'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { z } from 'zod';
import { Modal, ModalContent, ModalTrigger } from '@/components/Modal';
import { PaperSearch } from '@/components/PaperSearch';
import { MathText } from '@/components/MathText';
import { ui } from '@/components/ui';
import { pct, REP, rep } from '@/lib/format';
import { marketHeadline } from '@/lib/headline';
import { marketHref } from '@/lib/links';
import type * as S from '@/server/api/schemas';

type Listing = z.output<typeof S.Listing>;

/** Two short steps: explain the odds, then choose a paper using the onboarding picker. */
export function TutorialModal({
  kind,
  suggestions,
  startingBalanceMicro,
}: {
  kind: string;
  suggestions: Listing[];
  startingBalanceMicro: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState(0);
  const content = useRef<HTMLDivElement>(null);

  return (
    <Modal
      open={open}
      onOpenChange={(value) => {
        setOpen(value);
        if (value) setPage(0);
      }}
    >
      <ModalTrigger type="button" className={`font-sans text-sm ${ui.linkBtn}`}>
        [about]
      </ModalTrigger>
      <ModalContent
        ref={content}
        title={
          page === 0 ? (
            'acceptodds is like polymarket for peer review.'
          ) : (
            <>
              Every user is issued{' '}
              <span className="font-mono">
                {rep(startingBalanceMicro)} {REP}
              </span>{' '}
              they can “bet” with.
            </>
          )
        }
        titleClassName="font-serif text-[26px] leading-tight font-normal narrow:text-[22px]"
        wide
        className="max-h-[calc(100dvh-32px)] overflow-y-auto"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          content.current?.focus();
        }}
        onKeyDown={(event) => {
          if (
            page !== 0 ||
            event.key !== ' ' ||
            event.repeat ||
            event.altKey ||
            event.ctrlKey ||
            event.metaKey ||
            event.shiftKey ||
            !(event.target instanceof HTMLElement) ||
            event.target.closest('button, a, input, textarea, select, [contenteditable], [role="button"]')
          )
            return;
          event.preventDefault();
          setPage(1);
        }}
      >
        {page === 0 ? (
          <>
            <ProbabilityFigure listing={suggestions[0]} />
            <button type="button" className={ui.btn()} onClick={() => setPage(1)}>
              Next
            </button>
          </>
        ) : (
          <>
            <h2 className="mt-6 mb-3 font-serif text-lg font-normal">Choose a paper you have read (your own?)</h2>
            <PaperSearch
              kind={kind}
              suggestions={suggestions}
              onPick={(listing) => {
                const market = listing.markets[0];
                setOpen(false);
                router.push(marketHref({ marketSlug: market.slug, listingSlug: listing.slug }));
              }}
            />
            <button
              type="button"
              className={`mt-4 font-sans text-sm ${ui.linkBtn}`}
              onClick={() => {
                setPage(0);
                content.current?.focus();
              }}
            >
              ← Back
            </button>
          </>
        )}
      </ModalContent>
    </Modal>
  );
}

/** A two-colour headline bar, with sketch arrows drawn at its measured width. */
function ProbabilityFigure({ listing }: { listing?: Listing }) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!ref.current) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  const accept = listing?.markets[0] ? marketHeadline(listing.markets[0]) : null;
  const reject = accept === null ? null : 1 - accept;
  const rejectX = (width * (reject ?? 0.5)) / 2;
  const acceptX = width * ((reject ?? 0.5) + (accept ?? 0.5) / 2);

  return (
    <figure className="my-6">
      <div ref={ref}>
        <div className="flex h-5 overflow-hidden" aria-hidden>
          <span className="bg-reject" style={{ flex: reject ?? 1 }} />
          <span className="bg-accept" style={{ flex: accept ?? 1 }} />
        </div>
        <svg
          width={width}
          height="70"
          fill="none"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <g className="stroke-reject">
            <path d={`M ${width * 0.25} 65 C ${width * 0.25 + 18} 43, ${rejectX - 12} 36, ${rejectX} 7`} />
            <path d={`M ${rejectX - 7} 15 L ${rejectX} 6 L ${rejectX + 5} 17`} />
          </g>
          <g className="stroke-accept">
            <path d={`M ${width * 0.75} 65 C ${width * 0.75 - 18} 44, ${acceptX + 14} 34, ${acceptX} 7`} />
            <path d={`M ${acceptX - 5} 17 L ${acceptX} 6 L ${acceptX + 7} 15`} />
          </g>
        </svg>
        <div className="grid grid-cols-2 gap-3 text-center font-serif text-base italic">
          <span className="text-reject">
            Reject probability
            {reject !== null && <span className="mt-1 block font-mono text-sm not-italic">{pct(reject)}</span>}
          </span>
          <span className="text-accept">
            Accept probability
            {accept !== null && <span className="mt-1 block font-mono text-sm not-italic">{pct(accept)}</span>}
          </span>
        </div>
      </div>
      <figcaption className={ui.caption}>
        <b>Figure 1.</b>{' '}
        {listing ? (
          <>
            Current odds for <MathText text={listing.title} />.
          </>
        ) : (
          'How to read the probability bar.'
        )}
      </figcaption>
    </figure>
  );
}
