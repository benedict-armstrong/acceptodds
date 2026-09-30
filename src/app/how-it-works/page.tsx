import type { Metadata } from 'next';
import Link from 'next/link';
import { EqRef, Equation } from '@/components/Equation';
import { MathText } from '@/components/MathText';
import { Cite, References } from '@/components/References';
import { TitleBlock } from '@/components/TitleBlock';
import { ui } from '@/components/ui';
import { rep, REP } from '@/lib/format';
import { startingBalanceMicro } from '@/server/accounts';
import { siteName } from '@/server/share';

// The starting balance is read from the environment at request time.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'How it works · acceptodds' };

const prose = 'mt-2 space-y-3 leading-relaxed';

/**
 * How the markets work, for traders, set as a short paper: title block and
 * abstract, numbered sections, the market maker's equations, references.
 * Nothing here is data but the starting balance. It must stay true to the
 * engine — a mark is not a sale price (§1.1), selling is only of shares held,
 * the house funds each market and `b` is fixed at creation (§1.3, §1.7).
 *
 * Cross-references to sections ("§5") are written by hand, like the
 * equation and reference numbers: reorder the sections, fix them.
 */
export default function HowItWorksPage() {
  const start = `${rep(startingBalanceMicro(), 0)} ${REP}`;
  return (
    <main className={`${ui.page} max-w-[640px]`}>
      <TitleBlock
        title="How the markets work"
        byline={siteName()}
        abstract={`Every paper has a market on its decision. You buy shares in the outcome you believe in; each share of the outcome that happens pays 1 ${REP} and every other share pays nothing, so an outcome's price is the market's probability for it. Prices are set by an automated market maker, so there is always someone to trade with, and you can sell what you hold until trading closes. Trading is in reputation, which cannot be bought: everyone starts with ${start}.`}
      />

      <h2 id="trade" className={ui.groupHeading}>What you trade</h2>
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

      <h2 id="reputation" className={ui.groupHeading}>Reputation</h2>
      <div className={prose}>
        <p>
          Trading is in reputation, <span className="font-mono">{REP}</span>, not money. Everyone starts with{' '}
          <span className="font-mono">{start}</span> once they have confirmed an institutional email address. There is
          no way to buy more: the only way to gain is to be right before everyone else is.
        </p>
      </div>

      <h2 id="buying" className={ui.groupHeading}>Buying</h2>
      <div className={prose}>
        <p>
          You say how much to stake; the trade box shows how many shares that buys, as what it pays if the outcome wins.
          You always trade with the market maker (<a href="#maker">§5</a>), so there is never anyone to wait for.
        </p>
        <p>
          Buying moves the price <EqRef n={2} />. Each share you buy makes the next one dearer, so a large stake pays a
          higher average price than the one shown before you bought — the box shows the price before and after your
          trade.
        </p>
        <p>
          The cost you are shown is a limit. If someone else trades first and the price moves against you, your order is
          refused rather than filled at a worse price. If it moves in your favour, you pay less.
        </p>
      </div>

      <h2 id="selling" className={ui.groupHeading}>Selling</h2>
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

      <h2 id="maker" className={ui.groupHeading}>The market maker</h2>
      <div className={prose}>
        <p>
          Prices are set by an automated market maker, Hanson’s logarithmic market scoring rule (LMSR){' '}
          <Cite n={[1, 2]} />. It always quotes a price for any outcome, and the price depends only on how many shares of
          each outcome have been bought so far. Write <MathText text="$q_i$" /> for the shares of outcome{' '}
          <MathText text="$i$" /> bought so far, out of <MathText text="$n$" /> outcomes. The market maker keeps the
          cost function
        </p>
        <Equation n={1} tex={String.raw`C(q) = b \ln \sum_{i=1}^{n} e^{q_i / b},`} />
        <p>and the price of outcome <MathText text="$i$" /> is how fast that cost grows with its shares,</p>
        <Equation n={2} tex={String.raw`p_i(q) = \frac{e^{q_i / b}}{\sum_{j} e^{q_j / b}},`} />
        <p>
          which is always between 0 and 1, and sums to 1 over the outcomes. Buying <MathText text="$\Delta$" /> shares
          of <MathText text="$i$" /> costs the difference in <EqRef n={1} /> before and after; selling is the same with{' '}
          <MathText text="$\Delta$" /> negative, and pays back that difference. Costs are rounded to a millionth of a{' '}
          <span className="font-mono">{REP}</span>, always in the house’s favour.
        </p>
        <p>
          The depth <MathText text="$b$" /> — how far a given stake moves the price — is sized when the market is
          created, from the number of traders expected and the starting balance, so no single trader can pin a price on
          their own. It is then fixed for the life of the market. The house funds each market maker with
        </p>
        <Equation n={3} tex={String.raw`b \ln n,`} />
        <p>
          the most it can lose however the market resolves <Cite n={1} />, so every winning share is always paid.
        </p>
      </div>

      <h2 id="resolution" className={ui.groupHeading}>Resolution</h2>
      <div className={prose}>
        <p>
          Trading closes at the date shown on the market. When the decision is published, the market is settled on the
          outcome that happened, with a link to the evidence where there is one: each of its shares pays{' '}
          <span className="font-mono">1 {REP}</span> into your cash, and every other outcome’s shares are worth
          nothing.
        </p>
      </div>

      <h2 id="net-worth" className={ui.groupHeading}>Net worth and the leaderboard</h2>
      <div className={prose}>
        <p>
          Your net worth is your cash plus what selling every holding right now would pay (<a href="#selling">§4</a>).
          It is never shares × price, which would let a trader show a profit just by pushing up the price of what they
          hold.
        </p>
        <p>
          The <Link href="/leaderboard">leaderboard</Link> ranks everyone on that net worth, or on profit from settled
          markets alone.
        </p>
      </div>

      <References
        items={[
          <>
            R. Hanson. Combinatorial information market design. <i>Information Systems Frontiers</i>, 5(1):107–119,
            2003.
          </>,
          <>
            R. Hanson. Logarithmic market scoring rules for modular combinatorial information aggregation.{' '}
            <i>Journal of Prediction Markets</i>, 1(1):3–15, 2007.
          </>,
        ]}
      />
    </main>
  );
}
