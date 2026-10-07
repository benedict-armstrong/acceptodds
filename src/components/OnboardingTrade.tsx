'use client';

import useSWR from 'swr';
import { OddsBar } from '@/components/OutcomeBar';
import { usePassed } from '@/components/usePassed';
import type { z } from 'zod';
import { MAX_BAR_OUTCOMES } from '@/lib/headline';
import { marketPollInterval } from '@/lib/market-poll';
import type * as S from '@/server/api/schemas';
import { publicJson } from '@/app/markets/[slug]/MarketLive';
import { TradeBox, type Choice } from '@/app/markets/[slug]/TradeBox';

type Market = z.output<typeof S.Market>;

/** The market's odds bar and its own trade box, kept live. A visitor's hands back the choice; a viewer's places the order. */
export function OnboardingTrade({
  market: initial,
  viewer,
  onChoose,
  onFilled,
}: {
  market: Market;
  viewer: { signedIn: boolean; canTrade: boolean; cashMicro: string };
  onChoose?: (c: Choice) => void;
  onFilled: (c: Choice) => void;
}) {
  const { data: market = initial } = useSWR<Market>(`/api/v1/markets/${initial.id}`, publicJson, {
    fallbackData: initial,
    refreshInterval: (latest) => marketPollInterval(latest ?? initial),
    revalidateOnMount: true,
  });
  const closed = usePassed(new Date(market.closesAt).getTime());
  if (market.status !== 'open' || closed) {
    return <p className="my-4 text-muted">Trading has closed on this market. Choose another paper to make a trade.</p>;
  }
  const n = market.outcomes.length;
  return (
    <>
      {n >= 2 && n <= MAX_BAR_OUTCOMES && (
        <div className="mb-5">
          <OddsBar prices={market.outcomes.map((o) => o.price)} labels={market.outcomes.map((o) => o.label)} />
        </div>
      )}
      <p className="mb-1.5 text-sm text-muted">Pick an outcome and a stake.</p>
      <TradeBox
        market={market}
        cashMicro={BigInt(viewer.cashMicro)}
        viewer={viewer}
        onChoose={onChoose}
        onFilled={onFilled}
      />
    </>
  );
}
