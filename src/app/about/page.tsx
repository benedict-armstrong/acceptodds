import type { Metadata } from 'next';
import Link from 'next/link';
import { EqRef, Equation } from '@/components/Equation';
import { MathText } from '@/components/MathText';
import { Authors } from '@/components/Authors';
import { Cite, References } from '@/components/References';
import { TitleBlock } from '@/components/TitleBlock';
import { ui } from '@/components/ui';
import { REPO_URL } from '@/lib/links';
import { Wordmark } from '@/components/Wordmark';
import { rep, REP } from '@/lib/format';
import { startingBalanceMicro } from '@/server/accounts';
import { venues } from '@/venues';

// The starting balance is read from the environment at request time.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'About | acceptodds',
  description:
    'What acceptodds is and how its markets price papers: the LMSR market maker, reputation, selling, and settlement.',
  alternates: { canonical: '/about' },
};

/** Wasserman's essay against peer review: linked under the title and cited as [1]. */
const WASSERMAN =
  'https://www.stat.cmu.edu/~brian/zach-00/765-2019/764-2016/week05/refereeing/Larry-Abolish-the-Peer-Review.pdf';

const prose = 'mt-2 space-y-3 leading-relaxed';

/**
 * About the site and how the markets work, for traders, set as a short
 * paper: title block and abstract, numbered sections, the market maker's
 * equations, references.
 * Nothing here is data but the starting balance. It must stay true to the
 * engine — a mark is not a sale price (§1.1), selling is only of shares held,
 * the house funds each market and `b` is fixed at creation (§1.3, §1.7).
 *
 * Cross-references to sections ("§5") are written by hand, like the
 * equation and reference numbers: reorder the sections, fix them.
 */
export default function AboutPage() {
  const start = `${rep(startingBalanceMicro(), 0)} ${REP}`;
  return (
    <main className={`${ui.page} max-w-160`}>
      <TitleBlock
        title={
          <>
            About <Wordmark />
          </>
        }
        byline={<Authors authors={[{ name: 'Benedict Armstrong', affiliations: ['ETH Zürich'] }]} />}
        abstract={
          <>
            <Wordmark /> {` `} is a prediction market for papers under review. Every paper has a market on its decision
            (e.g. Accept or Reject), and its price is what the people trading it think the odds are. Users buy shares in
            the outcome they believe in. Shares can be bought and sold at any time and when a market is settled users
            who are holding the winning outcome are paid out 1 {`${REP}`} for each of their shares. Prices are set by an
            automated logarithmic market maker so there is always enough liquidity in the market. Trading is in
            reputation, which cannot be bought: everyone starts with {`${start}`}. It is a game made for fun, and has no
            connection to {[...new Set(venues().flatMap((v) => v.unaffiliated))].join(', ')} or any other organization
            and the code is available at:{' '}
            <a href={REPO_URL} className={ui.hyperref}>
              {REPO_URL.replace(/^https:\/\//, '')}
            </a>
            . The outcome of this experiment is yet to be determined by everyone here
          </>
        }
        abstractFull
      >
        {/* <div className="mt-1.5 flex flex-wrap justify-center gap-x-3 font-sans text-[13px]">
          <a href={WASSERMAN} className="text-accent" rel="noopener noreferrer" target="_blank">
            [Wasserman Paper]
          </a>
        </div> */}
      </TitleBlock>

      <h2 id="why" className={ui.groupHeading}>
        Why
      </h2>
      <div className={prose}>
        <p>
          Peer review decides which papers a conference accepts, and it is noisy: two equally qualified referees can
          reach opposite verdicts on the same paper <Cite n={1} />. A market asks a different question — not what two or
          three referees will say, but what everyone who has read the paper expects them to — and puts a number on the
          answer that anyone can check against the decision.
        </p>
        <p>
          A trader who is right before the decision gains reputation, and one who is wrong loses it, so over many papers
          the leaderboard shows whose judgement of research holds up. Anyone with an institutional email address can
          take part, and every paper under review has a market, opened the first time someone asks for one.
        </p>
      </div>

      <h2 id="trade" className={ui.groupHeading}>
        What you trade
      </h2>
      <div className={prose}>
        <p>Each paper has one market, which asks its venue’s question:</p>
        <ul className="list-disc space-y-1 pl-6">
          {venues().map((v) => (
            <li key={v.kind}>
              <b>{v.kind}</b>: {v.market.question}? Outcomes{' '}
              {v.market.outcomes.map((o, i) => (
                <span key={o.label}>
                  {i > 0 && ' and '}
                  <i>{o.label}</i>
                </span>
              ))}
              .
            </li>
          ))}
        </ul>
        <p>Each market’s contract, on its page, says exactly how it resolves, edge cases included.</p>
        <p>
          You buy <b>shares</b> in an outcome. When the market settles, every share of the outcome that happened pays{' '}
          <span className="font-mono">1 {REP}</span>; every other share pays nothing.
        </p>
        <p>
          So an outcome’s price is the market’s probability for it: a share at 30% costs about{' '}
          <span className="font-mono">0.30 {REP}</span> and pays <span className="font-mono">1 {REP}</span> if it wins.
          The two prices always add up to 100%, and the figure shown for a paper (
          {venues()
            .map((v) => `“${v.headlineLabel}”`)
            .join(', ')}
          ) is the price of its first outcome.
        </p>
      </div>

      <h2 id="reputation" className={ui.groupHeading}>
        Reputation
      </h2>
      <div className={prose}>
        <p>
          Trading is in reputation, <span className="font-mono">{REP}</span>, not money. Everyone starts with{' '}
          <span className="font-mono">{start}</span> once they have confirmed an institutional email address. There is
          no way to buy more: the only way to gain is to be right before everyone else is.
        </p>
      </div>

      <h2 id="buying" className={ui.groupHeading}>
        Buying
      </h2>
      <div className={prose}>
        <p>
          You say how much to stake; the trade box shows how many shares that buys, as what it pays if the outcome wins.
          You always trade with the market maker (<a href="#maker">§6</a>), so there is never anyone to wait for.
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

      <h2 id="selling" className={ui.groupHeading}>
        Selling
      </h2>
      <div className={prose}>
        <p>
          You can sell shares you hold, in part or in full, at any time until trading closes. You cannot sell shares you
          do not hold: there is no shorting. To bet against acceptance, buy <i>Reject</i>.
        </p>
        <p>
          Selling moves the price down as you sell, so selling a holding pays <b>less</b> than its shares times the
          current price. That is why your positions show a “current value” — what selling everything now would actually
          pay — and not shares × price. Right after a buy it is a little below what you paid: buying and immediately
          selling back loses a little, never gains.
        </p>
      </div>

      <h2 id="maker" className={ui.groupHeading}>
        The market maker
      </h2>
      <div className={prose}>
        <p>
          Prices are set by an automated market maker, Hanson’s logarithmic market scoring rule (LMSR){' '}
          <Cite n={[2, 3]} />. It always quotes a price for any outcome, and the price depends only on how many shares
          of each outcome have been bought so far. Write <MathText text="$q_i$" /> for the shares of outcome{' '}
          <MathText text="$i$" /> bought so far, out of <MathText text="$n$" /> outcomes. The market maker keeps the
          cost function
        </p>
        <Equation n={1} tex={String.raw`C(q) = b \ln \sum_{i=1}^{n} e^{q_i / b},`} />
        <p>
          and the price of outcome <MathText text="$i$" /> is how fast that cost grows with its shares,
        </p>
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
          the most it can lose however the market resolves <Cite n={2} />, so every winning share is always paid.
        </p>
      </div>

      <h2 id="resolution" className={ui.groupHeading}>
        Resolution
      </h2>
      <div className={prose}>
        <p>
          Trading closes at the date shown on the market. When the decision is published, the market is settled on the
          outcome that happened, with a link to the evidence where there is one: each of its shares pays{' '}
          <span className="font-mono">1 {REP}</span> into your cash, and every other outcome’s shares are worth nothing.
        </p>
      </div>

      <h2 id="net-worth" className={ui.groupHeading}>
        Net worth and the leaderboard
      </h2>
      <div className={prose}>
        <p>
          Your net worth is your cash plus what selling every holding right now would pay (<a href="#selling">§5</a>).
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
            L. Wasserman.{' '}
            <a href={WASSERMAN} rel="noopener noreferrer" target="_blank">
              A world without referees
            </a>
            . Essay, Carnegie Mellon University, 2012.
          </>,
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
