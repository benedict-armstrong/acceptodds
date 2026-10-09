'use client';

import { useEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import useSWR from 'swr';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { z } from 'zod';
import { Markdown } from '@/components/Markdown';
import { Modal, ModalContent, ModalTrigger } from '@/components/Modal';
import { OddsBar } from '@/components/OutcomeBar';
import { PositionsTable } from '@/components/PositionsTable';
import { PriceChart, type ChartPoint } from '@/components/PriceChart';
import { ui } from '@/components/ui';
import { VenueStanding } from '@/components/VenueStanding';
import { usePassed } from '@/components/usePassed';
import { marketPollInterval, tapePollInterval } from '@/lib/market-poll';
import { day, pct } from '@/lib/format';
import { headlineLabel, marketHeadline, MAX_BAR_OUTCOMES } from '@/lib/headline';
import { likelihoodClass, marketLikelihood } from '@/lib/likelihood';
import { welcomeBetHref } from '@/lib/onboarding';
import type { VenueField } from '@/server/venue-field';
import type * as S from '@/server/api/schemas';
import { Comments } from './Comments';
import { showsVenueStanding } from './figures';
import { TAPE_LIMIT } from './tape';
import { TapeTable } from './TapeTable';
import { FirstTrade } from './FirstTrade';
import { TradeBox } from './TradeBox';
import { venue } from '@/venues';

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
  /** The venue's headlines, for a main market that is still trading; else `null`. */
  venue: VenueField | null;
  viewer: { signedIn: boolean; canTrade: boolean };
  /** What a new account starts with: a visitor's balance in the trade box. */
  startingBalanceMicro: string;
}

async function fetchJson(url: string, credentials: RequestCredentials) {
  const response = await fetch(url, { credentials });
  if (!response.ok) throw new Error(`Request failed (${response.status})`);
  return response.json();
}

/** Public reads go out without cookies: anonymous, and not counted against the viewer's rate limit. */
export const publicJson = (url: string) => fetchJson(url, 'omit');
/** Reads that need the viewer (their portfolio, "you" on comments). */
export const viewerJson = (url: string) => fetchJson(url, 'same-origin');

/**
 * A market's board, chart, trade box, tape and comments, kept live by polling.
 * `embedded` when it sits under a listing's own title (the paper page): the
 * question is then a sub-heading rather than the page title. Its tables are
 * numbered from `firstTable`. `beforeDiscussion` goes between the board and
 * the comments (the paper page's related papers).
 */
export function MarketLive({
  initial,
  embedded = false,
  firstTable = 1,
  beforeDiscussion,
}: {
  initial: Initial;
  embedded?: boolean;
  /** The number of its first table: the page may have numbered tables above it. */
  firstTable?: number;
  beforeDiscussion?: ReactNode;
}) {
  const router = useRouter();
  const id = initial.market.id;
  const { data: market = initial.market, mutate: refreshMarket } = useSWR<Market>(`/api/v1/markets/${id}`, publicJson, {
    fallbackData: initial.market,
    refreshInterval: (latest) => marketPollInterval(latest ?? initial.market),
    revalidateOnMount: false,
  });
  const { data: tape = initial.tape, mutate: refreshTape } = useSWR<Tape>(
    `/api/v1/markets/${id}/orders?limit=${TAPE_LIMIT}`,
    publicJson,
    {
      fallbackData: initial.tape,
      refreshInterval: () => tapePollInterval(market),
      revalidateOnMount: false,
    },
  );
  const { data: portfolio, mutate: refreshPortfolio } = useSWR<Portfolio | null>(
    initial.viewer.signedIn ? `/api/v1/me/portfolio?marketId=${id}` : null,
    viewerJson,
    { fallbackData: initial.portfolio, refreshInterval: 15_000, revalidateOnMount: false },
  );

  const previousStatus = useRef(initial.market.status);
  useEffect(() => {
    if (market.status !== previousStatus.current) {
      previousStatus.current = market.status;
      void refreshTape();
      void refreshPortfolio();
    }
  }, [market.status, refreshTape, refreshPortfolio]);

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
  const closed = usePassed(new Date(market.closesAt).getTime());
  const tradable = market.status === 'open' && !closed;
  // Nothing to chart or list before the first fill: the trade box stands alone, centred.
  const untraded = market.orderCount === 0;
  const sorted =
    market.outcomes.length === 2 ? market.outcomes : [...market.outcomes].sort((a, b) => b.price - a.price);
  const lead = likelihoodClass(marketLikelihood(market)).text;
  // Two to four ordered outcomes while trading: the headline and the outcome
  // bar, worst on the left (a binary paper market: reject, accept).
  const n = market.outcomes.length;
  const barred = n >= 2 && n <= MAX_BAR_OUTCOMES && (market.status === 'open' || market.status === 'closed');
  const headline = marketHeadline(market);
  // On a paper's page the question and the headline read as one sentence,
  // in the venue's words (`venues/`); a kind with no venue keeps its question.
  const chanceOf = embedded ? venue(market.kind)?.chanceOf : undefined;
  const sentence = chanceOf !== undefined && barred && headline !== null;

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
      <div className="mt-6 text-center font-mono text-[13px] text-muted">
        {sentence ? statusLine(market) : `${market.kind}, ${statusLine(market)}`}
      </div>
      {sentence ? (
        <h2 className="mt-1 mb-1 text-center text-[22px] leading-tight font-normal narrow:text-xl">
          est. <b className={lead}>{pct(headline)}</b> chance {chanceOf}.
        </h2>
      ) : embedded ? (
        <h2 className="mt-1 mb-1 text-center text-[22px] leading-tight font-normal narrow:text-xl">
          {market.question}
        </h2>
      ) : (
        <h1 className="mt-2 mb-1 text-center text-[30px] leading-tight font-normal narrow:text-2xl">
          {market.question}
        </h1>
      )}
      {market.description && (
        <div className="mx-auto max-w-[640px] text-center text-sm text-muted">{market.description}</div>
      )}

      {barred && headline !== null ? (
        <div className="mx-auto my-7 max-w-[560px]">
          {!sentence && (
            <div className="mb-2 text-center text-[22px]">
              <span className={lead}>
                <b>{pct(headline)}</b> {headlineLabel(labels, embedded ? market.kind : null)}
              </span>
            </div>
          )}
          <OddsBar prices={market.outcomes.map((o) => o.price)} labels={labels} />
        </div>
      ) : (
        <div className="my-7 flex flex-wrap justify-center gap-x-9 gap-y-2 text-[22px]">
          {sorted.map((o, i) => (
            <span key={o.id} className={i === 0 ? lead : 'text-muted'}>
              <b>{pct(o.price)}</b> {o.label}
              {market.resolvedOutcomeId === o.id && ' ✓'}
            </span>
          ))}
        </div>
      )}

      {!untraded && (
        <div className="py-4">
          <PriceChart
            points={points}
            labels={labels}
            caption={
              <>
                <b>Figure 1.</b> {market.outcomes.length === 2 ? `${labels[0]} price` : 'Prices'} since opening.
              </>
            }
          />
        </div>
      )}

      {holdings.length > 0 && (
        <div className="mt-10">
          <h3 className={`${ui.section} mb-3`}>Your positions</h3>
          <PositionsTable
            holdings={holdings}
            caption={
              <>
                <b>Table {firstTable}.</b> Your open positions in this market.
              </>
            }
            sellable={tradable && initial.viewer.canTrade ? [market.id] : []}
            onFilled={onFilled}
          />
        </div>
      )}

      <div className={untraded ? 'mx-auto mt-10 max-w-[480px]' : 'mt-10 grid grid-cols-2 gap-10 narrow:grid-cols-1'}>
        {!untraded && (
          <div>
            <h3 className={`${ui.section} mb-3`}>Recent trades</h3>
            <div className="overflow-x-auto">
              <TapeTable market={market} tape={tape} n={firstTable + (holdings.length > 0 ? 1 : 0)} />
            </div>
          </div>
        )}
        {/* On a narrow screen the trade box comes before the tape. `#trade` is where "Place a bet" links. */}
        <div id="trade" className="scroll-mt-4 narrow:order-first">
          {tradable ? (
            <Trading
              market={market}
              cashMicro={
                initial.viewer.signedIn
                  ? portfolio
                    ? // The wallet of this market's venue; none yet means a first trade there opens it.
                      BigInt(
                        portfolio.wallets.find((w) => w.kind === market.kind)?.cashMicro ??
                          initial.startingBalanceMicro,
                      )
                    : null
                  : BigInt(initial.startingBalanceMicro)
              }
              viewer={initial.viewer}
              onFilled={onFilled}
              // A visitor's bet opens onboarding past the paper and bet steps.
              onChoose={
                initial.viewer.signedIn ? undefined : (c) => router.push(welcomeBetHref({ marketId: id, ...c }))
              }
              paper={embedded}
            />
          ) : (
            <div className={ui.box}>
              <h3 className={ui.boxHeading}>{market.status === 'settled' ? 'Resolved' : 'Trading closed'}</h3>
              {market.status === 'settled' ? (
                <div>
                  <b>{label(market.resolvedOutcomeId ?? '')}</b>
                  {market.resolutionEvidenceUrl && (
                    <>
                      {' '}
                      <a href={market.resolutionEvidenceUrl}>evidence</a>
                    </>
                  )}
                </div>
              ) : (
                <div className="text-muted">Awaiting resolution.</div>
              )}
            </div>
          )}
          <div className="mt-1.5 flex justify-between gap-3 text-xs text-faint">
            <Link href="/about" className="hover:underline">
              How do these markets work?
            </Link>
            {market.contract && (
              <Modal>
                <ModalTrigger className="cursor-pointer hover:underline">Contract</ModalTrigger>
                <ModalContent title="Contract" wide>
                  <Markdown className="text-sm">{market.contract}</Markdown>
                </ModalContent>
              </Modal>
            )}
          </div>
        </div>
      </div>

      {/* Only once it has traded: before that, its price is the opening one, not a belief. */}
      {initial.venue && headline !== null && showsVenueStanding(market, true) && (
        <VenueStanding field={initial.venue} headline={headline} />
      )}

      {beforeDiscussion}

      <Comments
        marketId={id}
        outcomeIds={market.outcomes.map((o) => o.id)}
        initial={initial.comments}
        viewer={initial.viewer}
        tradable={tradable}
        version={commentsVersion}
        onChanged={() => void refreshPortfolio()}
      />
    </>
  );
}

/**
 * The first bet on a market is its own flow (`FirstTrade`); after that, the
 * plain trade box, on a paper under the same reassurance the first bet gives.
 */
function Trading(props: ComponentProps<typeof TradeBox> & { paper: boolean }) {
  const { paper, ...box } = props;
  if (box.market.orderCount === 0) return <FirstTrade {...box} paper={paper} />;
  if (!paper) return <TradeBox {...box} />;
  return (
    <div>
      <p className="mb-2 text-xs text-muted">All positions stay anonymous.</p>
      <TradeBox {...box} />
    </div>
  );
}

function statusLine(m: Market): string {
  if (m.status === 'settled') return `settled ${m.settledAt ? day(m.settledAt) : ''}`;
  if (m.status === 'closed') return 'closed';
  return `open until ${day(m.closesAt)}`;
}
