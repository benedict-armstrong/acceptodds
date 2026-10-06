import type { ReactNode } from 'react';
import Link from 'next/link';
import { MathText } from '@/components/MathText';
import { OutcomeBar } from '@/components/OutcomeBar';
import { Sparkline } from '@/components/Sparkline';
import { pct, rep, REP } from '@/lib/format';
import { marketHeadline } from '@/lib/headline';
import { likelihoodClass, marketLikelihood } from '@/lib/likelihood';

type RowMarket = {
  question: string;
  status: string;
  resolvedOutcomeId: string | null;
  outcomes: { id: string; label: string; ordinal: number; price: number }[];
};

/**
 * One paper in a list, as the home page sets it: the likelihood edge, its
 * [pdf], title and authors, volume, sparkline and headline. The whole row is
 * one target: a link (`href`), or a button (`onPick`) for a list that
 * chooses rather than navigates (`/welcome`).
 */
export function PaperRow({
  title,
  authors,
  pdf,
  tldr,
  market,
  volumeMicro,
  spark,
  href,
  onPick,
}: {
  title: string;
  authors: string[];
  pdf?: { url: string; label: string };
  /** Shown under the authors when given. */
  tldr?: string | null;
  /** The market that stands for the row: its headline and outcome bar. Null before its first trade: no price yet. */
  market: RowMarket | null;
  /** `null` while nothing has traded. */
  volumeMicro: bigint | string | null;
  spark: number[];
  href?: string;
  onPick?: () => void;
}) {
  const look = likelihoodClass(market ? marketLikelihood(market) : null);
  const target = 'line-clamp-2 after:absolute after:inset-0 hover:no-underline';
  const name = <MathText text={title} />;
  return (
    <div className="relative grid grid-cols-[3px_34px_1fr_90px_90px_110px] items-center gap-x-3.5 border-b border-dotted border-rule-strong py-2 hover:bg-highlight narrow:grid-cols-[3px_34px_1fr_64px]">
      <span className={`self-stretch ${look.bar}`} aria-hidden />
      <span className="font-sans text-xs">
        {pdf && (
          <a href={pdf.url} className="relative z-10 text-accent" rel="noopener noreferrer" target="_blank">
            [{pdf.label}]
          </a>
        )}
      </span>
      <span className="min-w-0 leading-[1.35]">
        {/* At most two lines; the whole title on hover. */}
        {onPick ? (
          <button type="button" className={`${target} cursor-pointer text-left`} title={title} onClick={onPick}>
            {name}
          </button>
        ) : (
          <Link href={href ?? '#'} className={target} title={title}>
            {name}
          </Link>
        )}
        {authors.length > 0 && <span className="block font-sans text-xs text-muted">{authorLine(authors)}</span>}
        {tldr && (
          <span className="mt-0.5 block text-[13px] leading-snug text-muted">
            <MathText text={tldr} />
          </span>
        )}
      </span>
      <span className="text-right font-mono text-xs text-muted narrow:hidden" title="volume">
        {volumeMicro !== null ? `${rep(volumeMicro, 0)} ${REP}` : ''}
      </span>
      <span className="narrow:hidden" title={market?.question}>
        {market && <Sparkline values={spark} />}
      </span>
      <span
        className={`text-right font-mono text-sm ${look.text}`}
        title={market ? `${market.question}: chance of acceptance` : 'Not traded yet'}
      >
        {market && headline(market)}
      </span>
    </div>
  );
}

/** "A, B, C et al." — enough to recognise a paper by. */
export function authorLine(names: string[]): string {
  return names.length > 3 ? `${names.slice(0, 3).join(', ')} et al.` : names.join(', ');
}

/**
 * The headline (`lib/headline.ts`: for a paper, accepted in any form), with
 * the outcome bar under it for two to four outcomes. Settled: the
 * winner. Void: nothing.
 */
function headline(m: RowMarket): ReactNode {
  if (m.status === 'settled') {
    return m.outcomes.find((o) => o.id === m.resolvedOutcomeId)?.label ?? 'settled';
  }
  const h = marketHeadline(m);
  if (h === null) return '—';
  return (
    <span className="inline-flex flex-col items-end gap-1">
      {pct(h)}
      <OutcomeBar
        prices={m.outcomes.map((o) => o.price)}
        labels={m.outcomes.map((o) => o.label)}
        className="h-1 w-14"
      />
    </span>
  );
}
