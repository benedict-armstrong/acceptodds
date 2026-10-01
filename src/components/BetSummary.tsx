import type { z } from 'zod';
import { rep, REP } from '@/lib/format';
import type * as S from '@/server/api/schemas';
import { MathText } from './MathText';
import { sharesForStake } from './quote';

type Market = z.output<typeof S.Market>;

/**
 * A bet as chosen, set the same wherever it is shown (the email step, the
 * finish page): the paper, then venue, stake and outcome, then what it pays
 * if it wins on the board as given (1 per share, §1.1: a payout, not a value).
 */
export function BetSummary({
  title,
  market,
  outcomeId,
  stakeMicro,
}: {
  title: string;
  market: Market;
  outcomeId: string;
  stakeMicro: bigint;
}) {
  const idx = market.outcomes.findIndex((o) => o.id === outcomeId);
  const label = market.outcomes[idx]?.label;
  const pays = idx >= 0 ? sharesForStake(market, idx, stakeMicro) : null;
  return (
    <p className="mb-4">
      <MathText text={title} />
      <span className="block text-muted">
        {market.kind}, {rep(stakeMicro)} {REP} on {label}
        {pays !== null && (
          <>
            {' '}
            and pays {rep(pays)} {REP} if it wins
          </>
        )}
      </span>
    </p>
  );
}
