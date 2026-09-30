import type { Metadata } from 'next';
import Link from 'next/link';
import { ui } from '@/components/ui';
import { rep, REP } from '@/lib/format';
import { startingBalanceMicro } from '@/server/accounts';

// The starting balance is read from the environment at request time.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'How it works · acceptodds' };

const prose = 'mt-2 space-y-3 leading-relaxed';

/**
 * How the markets work, for traders. Plain prose: nothing here is data but
 * the starting balance. It must stay true to the engine — a mark is not a
 * sale price (§1.1), selling is only of shares held, the house funds each
 * market and `b` is fixed at creation (§1.3, §1.7).
 */
export default function HowItWorksPage() {
  const start = `${rep(startingBalanceMicro(), 0)} ${REP}`;
  return (
    <main className={`${ui.page} max-w-[640px]`}>
      <h1 className="mt-4 text-[26px] leading-tight font-normal">How the markets work</h1>

      <h2 className={ui.groupHeading}>What you trade</h2>
      <div className={prose}>
        <p>
          Each paper has a market on its decision, usually with four outcomes, best first: <i>Oral</i>,{' '}
          <i>Spotlight</i>, <i>Poster</i> and <i>Reject</i>. A withdrawn or desk-rejected paper counts as{' '}
          <i>Reject</i>.
        </p>
        <p>
          You buy <b>shares</b> in an outcome. When the decision is published, every share of the outcome that happened
          pays <span className="font-mono">1 {REP}</span>; every other share pays nothing.
        </p>
        <p>
          So an outcome’s price is the market’s probability for it: a share at 30% costs about{' '}
          <span className="font-mono">0.30 {REP}</span> and pays <span className="font-mono">1 {REP}</span> if it wins.
          The prices of a market’s outcomes always add up to 100%. The single “accept” figure shown for a paper is
          everything but <i>Reject</i>: 100% minus the price of <i>Reject</i>.
        </p>
      </div>

      <h2 className={ui.groupHeading}>Reputation</h2>
      <div className={prose}>
        <p>
          Trading is in reputation, <span className="font-mono">{REP}</span>, not money. Everyone starts with{' '}
          <span className="font-mono">{start}</span> once they have confirmed an institutional email address. There is
          no way to buy more: the only way to gain is to be right before everyone else is.
        </p>
      </div>

      <h2 className={ui.groupHeading}>Buying</h2>
      <div className={prose}>
        <p>
          You say how much to stake; the trade box shows how many shares that buys, as what it pays if the outcome wins.
          You always trade with the market maker (below), so there is never anyone to wait for.
        </p>
        <p>
          Buying moves the price. Each share you buy makes the next one dearer, so a large stake pays a higher average
          price than the one shown before you bought — the box shows the price before and after your trade.
        </p>
        <p>
          The cost you are shown is a limit. If someone else trades first and the price moves against you, your order is
          refused rather than filled at a worse price. If it moves in your favour, you pay less.
        </p>
      </div>

      <h2 className={ui.groupHeading}>Selling</h2>
      <div className={prose}>
        <p>
          You can sell shares you hold, in part or in full, at any time until trading closes. You cannot sell shares you
          do not hold: there is no shorting. To bet against an outcome, buy the others.
        </p>
        <p>
          Selling moves the price down as you sell, so selling a holding pays <b>less</b> than its shares times the
          current price. That is why your positions show a “current value” — what selling everything now would actually
          pay — and not shares × price. Right after a buy it is a little below what you paid: buying and immediately
          selling back loses a little, never gains.
        </p>
      </div>

      <h2 className={ui.groupHeading}>The market maker</h2>
      <div className={prose}>
        <p>
          Prices are set by an automated market maker, Hanson’s logarithmic market scoring rule (LMSR). It always
          quotes a price for any outcome, and the price depends only on how many shares of each outcome have been
          bought so far.
        </p>
        <p>
          Its depth — how far a given stake moves the price — is sized when the market is created, from the number of
          traders expected and the starting balance, so no single trader can pin a price on their own. It is then fixed
          for the life of the market. The house funds each market maker, and its worst-case loss is bounded, so every
          winning share is always paid.
        </p>
      </div>

      <h2 className={ui.groupHeading}>Resolution</h2>
      <div className={prose}>
        <p>
          Trading closes at the date shown on the market. When the decision is published, the market is settled on the
          outcome that happened, with a link to the evidence where there is one: each of its shares pays{' '}
          <span className="font-mono">1 {REP}</span> into your cash, and every other outcome’s shares are worth
          nothing.
        </p>
      </div>

      <h2 className={ui.groupHeading}>Net worth and the leaderboard</h2>
      <div className={prose}>
        <p>
          Your net worth is your cash plus what selling every holding right now would pay. It is never shares × price,
          which would let a trader show a profit just by pushing up the price of what they hold.
        </p>
        <p>
          The <Link href="/leaderboard">leaderboard</Link> ranks everyone on that net worth, or on profit from settled
          markets alone.
        </p>
      </div>
    </main>
  );
}
