'use client';

import { useEffect, useRef, useState } from 'react';
import useSWR from 'swr';
import type { z } from 'zod';
import { PriceChart, type ChartPoint } from '@/components/PriceChart';
import { ago, day, pct, rep, shares } from '@/lib/format';
import type * as S from '@/server/api/schemas';
import { Comments } from './Comments';
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

export function MarketLive({ initial }: { initial: Initial }) {
  const id = initial.market.id;
  const { data: market = initial.market, mutate: refreshMarket } = useSWR<Market>(`/api/v1/markets/${id}`, publicJson, {
    fallbackData: initial.market,
    refreshInterval: POLL_MS,
  });
  const { data: tape = initial.tape, mutate: refreshTape } = useSWR<Tape>(`/api/v1/markets/${id}/orders?limit=20`, publicJson, {
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

  const onFilled = () => {
    void refreshMarket();
    void refreshTape();
    void refreshPortfolio();
  };

  return (
    <>
      <div className="eyebrow">
        {market.kind} · {statusLine(market)}
      </div>
      <h1 className="title">{market.question}</h1>
      {market.description && <div className="desc">{market.description}</div>}

      <div className="probs">
        {sorted.map((o, i) => (
          <span key={o.id} className={i === 0 ? 'lead' : 'rest'}>
            <b>{pct(o.price)}</b> {o.label}
            {market.resolvedOutcomeId === o.id && ' ✓'}
          </span>
        ))}
      </div>

      <div className="figure">
        {points.length > 1 ? (
          <>
            <PriceChart points={points} labels={labels} />
            <div className="caption">
              <b>Figure 1.</b> {market.outcomes.length === 2 ? `${labels[0]} price` : 'Prices'} since opening ·{' '}
              {market.orderCount} trades · {rep(market.volumeMicro, 0)} rep.
            </div>
          </>
        ) : (
          <div className="caption" style={{ padding: '18px 0', textAlign: 'center' }}>
            No trades yet.
          </div>
        )}
      </div>

      <div className="cols">
        <div>
          <h3 className="sec">Recent trades</h3>
          <div className="tape">
            {tape.orders.length === 0 && <div className="muted">—</div>}
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
        <div>
          {tradable ? (
            <TradeBox market={market} holdings={holdings} viewer={initial.viewer} onFilled={onFilled} />
          ) : (
            <div className="box">
              <h3 className="sec">{market.status === 'settled' ? 'Resolved' : 'Trading closed'}</h3>
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
                <div className="muted">Awaiting resolution.</div>
              )}
            </div>
          )}
        </div>
      </div>

      <Comments marketId={id} initial={initial.comments} viewer={initial.viewer} />
    </>
  );
}

function statusLine(m: Market): string {
  if (m.status === 'settled') return `settled ${m.settledAt ? day(m.settledAt) : ''}`;
  if (m.status === 'closed') return 'closed';
  return `open until ${day(m.closesAt)}`;
}
