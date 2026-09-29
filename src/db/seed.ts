import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { createAccount, createHouse, getAccountByHandle, startingBalanceMicro } from '@/server/accounts';
import { createMarket, trade } from '@/server/engine';
import { upsertListing } from '@/server/listings';
import { createDb, createPool, type Database } from './index';
import { accounts, markets } from './schema';

/**
 * The house account, one standalone market with two outcomes, one example
 * listing with three markets, and two traders — on an empty database only.
 * Then, on any database with a house, the anonymous example listings
 * (`seedAnonymous`), adding whichever are missing, so it can be rerun.
 *
 * Deliberately knows nothing about papers: the questions below are questions,
 * the listing is example text, and `../research` is what decides what the
 * venue actually lists and trades on. (The UI calls a listing a paper.)
 */
async function main() {
  const url = process.argv[2] ?? process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const pool = createPool(url);
  const db = createDb(pool);

  const existing = await db.select().from(accounts);
  if (existing.length > 0) {
    console.log(`database already has ${existing.length} accounts; not seeding the base set`);
  } else {
    await seedBase(db);
  }
  await seedAnonymous(db);
  await pool.end();
}

async function seedBase(db: Database) {
  const starting = startingBalanceMicro();

  // The house has to be able to cover every market's b*ln(n). Give it enough
  // to subsidise a few hundred two-outcome markets at this field size.
  const house = await createHouse(starting * 1000n, db);

  const alice = await createAccount(
    { handle: 'alice', displayName: 'Alice', grantMicro: starting },
    db,
  );
  const bot = await createAccount(
    { handle: 'bot-zero', displayName: 'Bot Zero', isBot: true, grantMicro: starting },
    db,
  );

  const closesAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
  const market = await createMarket(
    {
      slug: 'example-binary',
      question: 'Will the example resolve YES?',
      description: 'A seed market. The platform does not know or care what this is about.',
      kind: 'binary',
      outcomes: ['YES', 'NO'],
      closesAt,
      startingBalanceMicro: starting,
      expectedTraders: 50,
      status: 'open',
    },
    db,
  );

  // An example listing: opaque text and links, as a creating client would
  // send them. Rank 0 is its main market.
  const { listing } = await upsertListing(
    {
      slug: 'example-listing',
      title: 'An Example Listing: Grouping Several Markets Under One Subject',
      summary:
        'This is placeholder text standing in for whatever summary the creating client supplies. ' +
        'The venue stores it for display and never reads it. It is long enough to show the collapsed ' +
        'view on the listing page: a few lines, then a toggle to read the rest. Nothing here refers to ' +
        'a real document, and every link below points at example.org.',
      authors: ['Example Author', 'Second Author', 'Third Author', 'Fourth Author'],
      links: [
        { label: 'PDF', url: 'https://example.org/example-listing.pdf' },
        { label: 'OpenReview', url: 'https://example.org/forum?id=example-listing' },
      ],
      kind: 'example',
    },
    db,
  );
  const listed = [];
  for (const [rank, [suffix, question]] of [
    ['accept', 'Will the example subject be accepted?'],
    ['oral', 'Will the example subject get an oral?'],
    ['award', 'Will the example subject win an award?'],
  ].entries()) {
    listed.push(
      await createMarket(
        {
          slug: `example-listing-${suffix}`,
          question,
          kind: 'example',
          outcomes: ['YES', 'NO'],
          closesAt,
          startingBalanceMicro: starting,
          expectedTraders: 50,
          status: 'open',
          listingId: listing.id,
          listingRank: rank,
        },
        db,
      ),
    );
  }

  console.log(
    [
      `house       ${house.id}  balance ${house.balanceMicro}`,
      `alice       ${alice.id}  balance ${alice.balanceMicro}`,
      `bot-zero    ${bot.id}  balance ${bot.balanceMicro}`,
      `market      ${market.marketId}  b=${market.b}  subsidy=${market.subsidyMicro}`,
      `outcomes    ${market.outcomeIds.join(', ')}`,
      `listing     ${listing.id}  markets ${listed.map((m) => m.marketId).join(', ')}`,
    ].join('\n'),
  );
}

/**
 * Example listings with no authors, as a double-blind venue would list them,
 * in `ICLR 2027` so they show on the home page's default venue. Each gets one
 * two-outcome market (rank 0), traded by a seed bot to a target first-outcome
 * price in a few fills, so lists have a spread of prices and sparklines.
 * Idempotent: a listing is upserted by slug, and a market that already exists
 * is left alone, trades included.
 */
const ANONYMOUS: [slug: string, title: string, target: number][] = [
  ['anon-curriculum-free-rl', 'Curriculum-Free Reinforcement Learning via Self-Generated Goals', 0.82],
  ['anon-linear-probes-lie', 'Linear Probes Overstate What Representations Encode', 0.71],
  ['anon-state-space-recall', 'State Space Models Fail at Associative Recall, and How to Fix It', 0.64],
  ['anon-data-pruning-scaling', 'Beyond Power Laws: Data Pruning Changes the Scaling Exponent', 0.57],
  ['anon-muon-at-scale', 'An Empirical Study of Orthogonalised Optimisers at Scale', 0.52],
  ['anon-synthetic-data-collapse', 'Synthetic Data Does Not Always Collapse: A Mixing Analysis', 0.48],
  ['anon-agent-benchmarks-leak', 'Agent Benchmarks Leak Their Answers Through Tool Outputs', 0.43],
  ['anon-lora-rank-myth', 'The Low-Rank Myth: Fine-Tuning Updates Are Not Low Rank', 0.37],
  ['anon-mixture-routing-noise', 'Routing Noise, Not Capacity, Limits Mixture-of-Experts', 0.3],
  ['anon-vision-tokens-redundant', 'Most Vision Tokens Are Redundant After Layer Four', 0.24],
  ['anon-reasoning-length-prior', 'Longer Chains of Thought Are a Prior, Not a Skill', 0.16],
  ['anon-grokking-optimiser', 'Grokking Is an Artefact of the Optimiser', 0.09],
  // A title with inline TeX, and one long enough to be cut to two lines in lists.
  ['anon-sqrt-regret', 'An $O(\\sqrt{T \\log |\\mathcal{A}|})$ Regret Bound for $\\epsilon$-Greedy Exploration', 0.61],
  [
    'anon-long-title',
    'On the Surprising Effectiveness of Very Long Titles: A Large-Scale Empirical Study of How Paper Titles ' +
      'Grow Across Venues, Years and Subfields, With Implications for Reviewers, Readers and Layout Engines',
    0.34,
  ],
];

async function seedAnonymous(db: Database) {
  const closesAt = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000);
  const starting = startingBalanceMicro();
  // A bot of its own, so seeding does not spend the other traders' balances.
  const seeder =
    (await getAccountByHandle('bot-seed', db)) ??
    (await createAccount({ handle: 'bot-seed', displayName: 'Seed Bot', isBot: true, grantMicro: starting * 100n }, db));

  let added = 0;
  for (const [slug, title, target] of ANONYMOUS) {
    const { listing } = await upsertListing(
      {
        slug,
        title,
        summary:
          'Placeholder text for an anonymous submission. The venue stores it for display and never ' +
          'reads it; no authors are listed, as under double-blind review.',
        authors: [],
        links: [{ label: 'OpenReview', url: `https://example.org/forum?id=${slug}` }],
        kind: 'ICLR 2027',
      },
      db,
    );
    const marketSlug = `${slug}-accept`;
    const [found] = await db.select({ id: markets.id }).from(markets).where(eq(markets.slug, marketSlug));
    if (found) continue;

    const market = await createMarket(
      {
        slug: marketSlug,
        question: `Will "${title}" be accepted?`,
        kind: 'ICLR 2027',
        outcomes: ['YES', 'NO'],
        closesAt,
        startingBalanceMicro: starting,
        expectedTraders: 50,
        status: 'open',
        listingId: listing.id,
        listingRank: 0,
      },
      db,
    );
    // From 1/2 to `target`: q_yes − q_no = b·logit(target), bought in four
    // fills of the side it favours (b is in micro-units).
    const side = target >= 0.5 ? 0 : 1;
    const total = Math.abs(market.b * Math.log(target / (1 - target)));
    for (let i = 0; i < 4; i++) {
      const shares = BigInt(Math.round(total / 4));
      await trade(seeder.id, market.marketId, market.outcomeIds[side], shares, shares, randomUUID(), db);
    }
    added++;
  }
  console.log(`anonymous listings: ${ANONYMOUS.length} upserted, ${added} markets created`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
