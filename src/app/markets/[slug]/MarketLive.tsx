'use client';

import { useEffect, useRef, useState } from 'react';
import useSWR from 'swr';
import type { z } from 'zod';
import { OutcomeBar } from '@/components/OutcomeBar';
import { PriceChart, type ChartPoint } from '@/components/PriceChart';
import { ui } from '@/components/ui';
import { ago, day, pct, rep, REP, shares } from '@/lib/format';
import { barOrder, headlineLabel, marketHeadline, MAX_BAR_OUTCOMES, paletteSlot, TIER_BG } from '@/lib/headline';
import { likelihoodClass, marketLikelihood } from '@/lib/likelihood';
import type * as S from '@/server/api/schemas';
import { Comments } from './Comments';
import { TAPE_LIMIT } from './tape';
import { TradeBox } from './TradeBox';

type Market = z.output<typeof S.Market>;
type Tape = z.output<typeof S.Tape>;
type CommentList = z.output<typeof S.CommentList>;
type Portfolio = z.output<typeof S.Portfolio>;

export interface Initial {
  market: Market;
  history: ChartPoint[];
  tape: Tape;
  comments: CommentList;
  portfolio: Portfolio | null;
  viewer: { signedIn: boolean; canTrade: boolean };
}

/** Public reads go out without cookies: anonymous, and not counted against the viewer's rate limit. */
export const publicJson = (url: string) => fetch(url, { credentials: 'omit' }).then((r) => r.json());
/** Reads that need the viewer (their portfolio, "you" on comments). */
export const viewerJson = (url: string) => fetch(url).then((r) => r.json());

const POLL_MS = 3000;

/**
 * A market's board, chart, trade box, tape and comments, kept live by polling.
 * `embedded` when it sits under a listing's own title (the paper page): the
 * question is then a sub-heading rather than the page title.
 */
export function MarketLive({ initial, embedded = false }: { initial: Initial; embedded?: boolean }) {
  const id = initial.market.id;
  const { data: market = initial.market, mutate: refreshMarket } = useSWR<Market>(`/api/v1/markets/${id}`, publicJson, {
    fallbackData: initial.market,
    refreshInterval: POLL_MS,
  });
  const { data: tape = initial.tape, mutate: refreshTape } = useSWR<Tape>(`/api/v1/markets/${id}/orders?limit=${TAPE_LIMIT}`, publicJson, {
    fallbackData: initial.tape,
    refreshInterval: POLL_MS,
  });
  const { data: portfolio, mutate: refreshPortfolio } = useSWR<Portfolio | null>(
    initial.viewer.signedIn ? '/api/v1/me/portfolio' : null,
    viewerJson,
    { fallbackData: initial.portfolio, refreshInterval: POLL_MS * 2 },
  );

  // The chart starts from the full server-side history and grows by one point
  // whenever the tape shows a new fill: after a fill, the board's prices are
  // exactly the post-fill price vector.
  const [points, setPoints] = useState<ChartPoint[]>(initial.history);
  const seen = useRef(initial.tape.orders[0]?.id);
  useEffect(() => {
    const newest = tape.orders[0];
    if (!newest || newest.id === seen.current) return;
    seen.current = newest.id;
    setPoints((ps) => [...ps, { at: newest.createdAt, prices: market.outcomes.map((o) => o.price) }]);
  }, [tape, market]);

  const labels = market.outcomes.map((o) => o.label);
  const label = (outcomeId: string) => labels[market.outcomes.findIndex((o) => o.id === outcomeId)] ?? '?';
  const holdings = (portfolio?.holdings ?? []).filter((h) => h.marketId === id);
  const tradable = market.status === 'open' && new Date(market.closesAt).getTime() > Date.now();
  const sorted = market.outcomes.length === 2 ? market.outcomes : [...market.outcomes].sort((a, b) => b.price - a.price);
  const lead = likelihoodClass(marketLikelihood(market)).text;
  // Three or four ordered outcomes (a paper: oral, spotlight, poster, reject)
  // while trading: the headline and the outcome bar, worst on the left.
  const n = market.outcomes.length;
  const barred = n > 2 && n <= MAX_BAR_OUTCOMES && (market.status === 'open' || market.status === 'closed');
  const headline = marketHeadline(market);

  // A fill can trim the viewer's comment backings (a sell), so comments refresh too.
  const [commentsVersion, setCommentsVersion] = useState(0);
  const onFilled = () => {
    void refreshMarket();
    void refreshTape();
    void refreshPortfolio();
    setCommentsVersion((v) => v + 1);
  };

  return (
    <>
      <div className="mt-4.5 text-center font-mono text-[13px] text-muted">
        {market.kind} · {statusLine(market)}
      </div>
      {embedded ? (
        <h2 className="mt-1 mb-1 text-center text-[22px] leading-tight font-normal">{market.question}</h2>
      ) : (
        <h1 className="mt-2 mb-1 text-center text-[30px] leading-tight font-normal">{market.question}</h1>
      )}
      {market.description && <div className="mx-auto max-w-[640px] text-center text-sm text-muted">{market.description}</div>}

      {barred && headline !== null ? (
        <div className="mx-auto my-4.5 max-w-[560px]">
          <div className="text-center text-[22px]">
            <span className={lead}>
              <b>{pct(headline)}</b> {headlineLabel(labels, embedded)}
            </span>
          </div>
          <OutcomeBar prices={market.outcomes.map((o) => o.price)} labels={labels} className="mt-2 h-2.5 w-full" />
          <div className="mt-1.5 flex flex-wrap justify-between gap-x-4 font-sans text-[13px] text-subtle">
            {barOrder(n).map((i) => (
              <span key={i} className="whitespace-nowrap">
                <span className={`mr-1 inline-block size-2.5 rounded-[2px] align-[-1px] ${TIER_BG[paletteSlot(i, n)]}`} aria-hidden />
                {labels[i]} <b className="font-mono text-ink">{pct(market.outcomes[i].price)}</b>
              </span>
            ))}
          </div>
        </div>
      ) : (
        <div className="my-4.5 flex flex-wrap justify-center gap-x-9 gap-y-2 text-[22px]">
          {sorted.map((o, i) => (
            <span key={o.id} className={i === 0 ? lead : 'text-muted'}>
              <b>{pct(o.price)}</b> {o.label}
              {market.resolvedOutcomeId === o.id && ' ✓'}
            </span>
          ))}
        </div>
      )}

      <div className="border-y border-rule py-2.5">
        {points.length > 1 ? (
          <>
            <PriceChart points={points} labels={labels} />
            <div className={ui.caption}>
              <b>Figure 1.</b> {market.outcomes.length === 2 ? `${labels[0]} price` : 'Prices'} since opening ·{' '}
              {market.orderCount} trades · {rep(market.volumeMicro, 0)} {REP}.
            </div>
          </>
        ) : (
          <div className={`${ui.caption} py-4.5 text-center`}>
            No trades yet.
          </div>
        )}
      </div>

      <div className="mt-5.5 grid grid-cols-2 gap-8 narrow:grid-cols-1">
        <div>
          <h3 className={ui.sectionHeading}>Recent trades</h3>
          <div className="font-mono text-[13px] whitespace-nowrap [&>div]:py-0.5">
            {tape.orders.length === 0 && <div className="text-muted">—</div>}
            {tape.orders.map((o) => {
              const sell = o.sharesMicro.startsWith('-');
              return (
                <div key={o.id}>
                  <span suppressHydrationWarning>{ago(o.createdAt).padEnd(4)}</span> {sell ? 'sell' : 'buy '}{' '}
                  {shares(sell ? o.sharesMicro.slice(1) : o.sharesMicro)} {label(o.outcomeId)} &nbsp;{pct(o.priceBefore, true)} →{' '}
                  {pct(o.priceAfter, true)}
                </div>
              );
            })}
          </div>
        </div>
        {/* On a narrow screen the trade box comes before the tape. */}
        <div className="narrow:order-first">
          {tradable ? (
            <TradeBox market={market} holdings={holdings} viewer={initial.viewer} onFilled={onFilled} />
          ) : (
            <div className={ui.box}>
              <h3 className={ui.sectionHeading}>{market.status === 'settled' ? 'Resolved' : 'Trading closed'}</h3>
              {market.status === 'settled' ? (
                <div>
                  <b>{label(market.resolvedOutcomeId ?? '')}</b>
                  {market.resolutionEvidenceUrl && (
                    <>
                      {' '}
                      · <a href={market.resolutionEvidenceUrl}>evidence</a>
                    </>
                  )}
                </div>
              ) : (
                <div className="text-muted">Awaiting resolution.</div>
              )}
            </div>
          )}
        </div>
      </div>

      <Comments
        marketId={id}
        initial={initial.comments}
        viewer={initial.viewer}
        tradable={tradable}
        version={commentsVersion}
        onChanged={() => void refreshPortfolio()}
      />
    </>
  );
}

function statusLine(m: Market): string {
  if (m.status === 'settled') return `settled ${m.settledAt ? day(m.settledAt) : ''}`;
  if (m.status === 'closed') return 'closed';
  return `open until ${day(m.closesAt)}`;
}
