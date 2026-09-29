import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { asc, eq, sql } from 'drizzle-orm';
import {
  createAccount,
  createHouse,
  ensureAccountForUser,
  getAccountByHandle,
  startingBalanceMicro,
} from '@/server/accounts';
import { createAuth } from '@/server/better-auth';
import { HOUSE_HANDLE, closeMarket, createMarket, settle, trade } from '@/server/engine';
import { upsertListing } from '@/server/listings';
import { prices as lmsrPrices } from '@/lib/lmsr';
import { createDb, createPool, type Database } from './index';
import { accounts, markets, orders } from './schema';

/**
 * A dev database with something to look at (`npm run db:seed`), which first
 * wipes every table (local databases only):
 *
 * - on an empty database, the house, two traders, an unlisted binary market
 *   and an example listing with two markets (a paper can still have more
 *   than one);
 * - then, on any database with a house, a venue of made-up papers under
 *   `ICLR 2027`, each with the default single market — the four outcomes
 *   `Oral, Spotlight, Poster, Reject`, best first (issue #11 §4) — traded by
 *   a handful of seed bots along a noisy path to a plausible end price; and
 *   a few `ICLR 2026` papers already settled. Papers whose market exists are
 *   left alone, so it can be rerun.
 *
 * `--papers-only` (`npm run db:seed:demo`) skips the base set and creates just
 * the house if it is missing: demo data for a deployed database.
 *
 * The titles are invented. The platform still knows nothing about papers:
 * everything here goes in through the same engine and listing calls a client
 * would make. The one exception is `spreadOverTime`, a dev-only rewrite of
 * fill timestamps so charts have a history — see there.
 */
async function main() {
  const url = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const pool = createPool(url);
  const db = createDb(pool);

  if (!process.argv.includes('--papers-only')) await wipeData(url, db);

  const existing = await db.select().from(accounts);
  if (process.argv.includes('--papers-only')) {
    // For a deployed database: just the house (if missing) and the papers —
    // no example markets, no alice.
    if (!(await getAccountByHandle(HOUSE_HANDLE, db))) {
      await createHouse(startingBalanceMicro() * 1000n, db);
    }
  } else if (existing.length > 0) {
    console.log(`database already has ${existing.length} accounts; not seeding the base set`);
  } else {
    await seedBase(db);
  }
  await seedPapers(db);
  if (!process.argv.includes('--papers-only')) await seedAdmin(db);
  await pool.end();
}

/**
 * Empties every table in `public` (users and sessions included) so the full
 * seed starts from nothing. Refuses any database that is not on this machine;
 * `--papers-only` never calls it.
 */
async function wipeData(url: string, db: Database) {
  const host = new URL(url).hostname;
  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)) {
    throw new Error(`refusing to wipe ${host}: only a local database is reset (use --papers-only for others)`);
  }
  const { rows } = await db.execute<{ t: string }>(
    sql`select format('%I', tablename) as t from pg_tables where schemaname = 'public'`,
  );
  if (rows.length > 0) {
    await db.execute(sql.raw(`truncate table ${rows.map((r) => r.t).join(', ')} restart identity cascade`));
  }
  console.log(`wiped ${rows.length} tables`);
}

/** Dev-only password of the seeded admin; the seed refuses non-local databases. */
const ADMIN_PASSWORD = 'testtesttest';

/**
 * A confirmed, funded, verified user for the first `ADMIN_EMAILS` address, who
 * can sign in with `ADMIN_PASSWORD`. Inserted through Better Auth's own
 * adapter, so the password hash is its format, but past the sign-up hook and
 * the confirmation mail.
 */
async function seedAdmin(db: Database) {
  const email = (process.env.ADMIN_EMAILS ?? '').split(',')[0]?.trim().toLowerCase();
  if (!email) {
    console.log('ADMIN_EMAILS is empty; no admin user seeded');
    return;
  }
  const ctx = await createAuth(db).$context;
  const user = await ctx.internalAdapter.createUser(
    { email, name: 'Admin', emailVerified: true },
    { method: 'email-password' },
  );
  await ctx.internalAdapter.linkAccount({
    userId: user.id,
    providerId: 'credential',
    accountId: user.id,
    password: await ctx.password.hash(ADMIN_PASSWORD),
  });
  const account = await ensureAccountForUser({ id: user.id, name: user.name, email }, db);
  console.log(`admin       ${email}  (${account.handle}) password ${ADMIN_PASSWORD}`);
}

/** The four outcomes of a paper's market, best first; the headline is 1 − P(Reject). */
const DECISIONS = ['Oral', 'Spotlight', 'Poster', 'Reject'];
const DAY = 24 * 60 * 60 * 1000;

async function seedBase(db: Database) {
  const starting = startingBalanceMicro();

  // The house covers every market's b·ln(n).
  const house = await createHouse(starting * 1000n, db);
  const alice = await createAccount({ handle: 'alice', displayName: 'Alice', grantMicro: starting }, db);
  const bot = await createAccount(
    { handle: 'bot-zero', displayName: 'Bot Zero', isBot: true, grantMicro: starting },
    db,
  );

  const closesAt = new Date(Date.now() + 90 * DAY);
  const market = await createMarket(
    {
      slug: 'example-binary',
      question: 'Will the example resolve YES?',
      description: 'A seed market with no listing. The platform does not know or care what this is about.',
      kind: 'binary',
      outcomes: ['YES', 'NO'],
      closesAt,
      startingBalanceMicro: starting,
      expectedTraders: 50,
      status: 'open',
    },
    db,
  );

  // A listing with more than the default one market: rank 0 is its main one.
  const { listing } = await upsertListing(
    {
      slug: 'example-listing',
      title: 'An Example Listing: Grouping Several Markets Under One Subject',
      summary:
        'Placeholder text standing in for whatever summary the creating client supplies. The venue stores it ' +
        'for display and never reads it. Every link below points at example.org.',
      authors: ['Example Author', 'Second Author', 'Third Author', 'Fourth Author'],
      links: [
        { label: 'PDF', url: 'https://example.org/example-listing.pdf' },
        { label: 'OpenReview', url: 'https://example.org/forum?id=example-listing' },
      ],
      kind: 'example',
    },
    db,
  );
  await createMarket(
    {
      slug: 'example-listing-decision',
      question: 'How will the example venue decide?',
      kind: 'example',
      outcomes: DECISIONS,
      closesAt,
      startingBalanceMicro: starting,
      expectedTraders: 50,
      status: 'open',
      listingId: listing.id,
      listingRank: 0,
    },
    db,
  );
  await createMarket(
    {
      slug: 'example-listing-award',
      question: 'Will the example subject win an award?',
      kind: 'example',
      outcomes: ['YES', 'NO'],
      closesAt,
      startingBalanceMicro: starting,
      expectedTraders: 50,
      status: 'open',
      listingId: listing.id,
      listingRank: 1,
    },
    db,
  );

  console.log(
    [
      `house       ${house.id}`,
      `alice       ${alice.id}`,
      `bot-zero    ${bot.id}`,
      `market      ${market.marketId}  b=${market.b}`,
      `listing     ${listing.id}`,
    ].join('\n'),
  );
}

// ---------------------------------------------------------------------------
// papers
// ---------------------------------------------------------------------------

interface Paper {
  slug: string;
  title: string;
  /** End prices, best first: oral, spotlight, poster, reject. Normalised on use. */
  target: [number, number, number, number];
  summary: string;
  /** Only once deanonymised, i.e. after the decision. */
  authors?: string[];
  /** Settled papers: the decision (index into DECISIONS). */
  decided?: number;
}

const ICLR_2027: Paper[] = [
  {
    slug: 'sparse-moe-sublinear',
    title: 'Sparse Mixtures of Experts Scale Sublinearly in Active Parameters',
    target: [0.07, 0.18, 0.42, 0.33],
    summary:
      'We train 212 mixture-of-experts language models from 150M to 30B active parameters and find that loss scales ' +
      'with a smaller exponent in active parameters than dense models do, once routing entropy is held fixed. We give ' +
      'a simple correction to compute-optimal allocation and release all checkpoints.',
  },
  {
    slug: 'curriculum-free-rl',
    title: 'Curriculum-Free Reinforcement Learning via Self-Generated Goals',
    target: [0.12, 0.21, 0.45, 0.22],
    summary:
      'An agent that proposes its own goals from a learned model of what it can almost do matches hand-designed ' +
      'curricula on eleven sparse-reward benchmarks without any task-specific tuning.',
  },
  {
    slug: 'linear-probes-overstate',
    title: 'Linear Probes Overstate What Representations Encode',
    target: [0.02, 0.1, 0.5, 0.38],
    summary:
      'Probing accuracy is routinely read as evidence that a concept is encoded. We show that probes trained on ' +
      'random directions of equal norm reach comparable accuracy on 14 of 20 published probing tasks, and propose a ' +
      'control that separates the two.',
  },
  {
    slug: 'ssm-associative-recall',
    title: 'State Space Models Fail at Associative Recall, and How to Fix It',
    target: [0.04, 0.12, 0.43, 0.41],
    summary:
      'We isolate associative recall as the capability gap between state space models and attention, prove a lower ' +
      'bound on the state size needed for it, and close most of the gap with a two-layer hybrid.',
  },
  {
    slug: 'data-pruning-exponent',
    title: 'Beyond Power Laws: Data Pruning Changes the Scaling Exponent',
    target: [0.05, 0.14, 0.34, 0.47],
    summary:
      'Pruning pretraining data with a self-supervised difficulty metric improves the data scaling exponent, not ' +
      'just the constant, across three modalities.',
  },
  {
    slug: 'orthogonal-optimisers-scale',
    title: 'An Empirical Study of Orthogonalised Optimisers at Scale',
    target: [0.01, 0.06, 0.4, 0.53],
    summary:
      'We compare orthogonalised-update optimisers against AdamW at up to 7B parameters with tuned baselines and ' +
      'find the advantage shrinks, but does not vanish, as batch size grows.',
  },
  {
    slug: 'synthetic-data-mixing',
    title: 'Synthetic Data Does Not Always Collapse: A Mixing Analysis',
    target: [0.03, 0.08, 0.36, 0.53],
    summary:
      'Model collapse under recursive training is avoided whenever a constant fraction of real data is kept. We ' +
      'give the fraction in closed form for linear models and check it empirically for transformers.',
  },
  {
    slug: 'agent-benchmark-leaks',
    title: 'Agent Benchmarks Leak Their Answers Through Tool Outputs',
    target: [0.06, 0.16, 0.31, 0.47],
    summary:
      'In six popular agent benchmarks, tool outputs contain the gold answer verbatim for between 3% and 41% of ' +
      'tasks. We release patched versions and re-rank twelve published agents.',
  },
  {
    slug: 'lora-rank-myth',
    title: 'The Low-Rank Myth: Fine-Tuning Updates Are Not Low Rank',
    target: [0.01, 0.04, 0.26, 0.69],
    summary:
      'Full fine-tuning updates of large language models have slowly decaying spectra; LoRA works despite this, ' +
      'not because of it.',
  },
  {
    slug: 'moe-routing-noise',
    title: 'Routing Noise, Not Capacity, Limits Mixture-of-Experts',
    target: [0.01, 0.03, 0.24, 0.72],
    summary: 'Replacing learned routing with a fixed hash loses surprisingly little. We argue the router mostly adds noise.',
  },
  {
    slug: 'vision-tokens-redundant',
    title: 'Most Vision Tokens Are Redundant After Layer Four',
    target: [0.02, 0.07, 0.3, 0.61],
    summary:
      'Dropping 80% of image tokens after the fourth layer of a vision-language model costs under one point on ' +
      'eight benchmarks and halves inference cost.',
  },
  {
    slug: 'cot-length-prior',
    title: 'Longer Chains of Thought Are a Prior, Not a Skill',
    target: [0.01, 0.02, 0.15, 0.82],
    summary: 'Reasoning length transfers across unrelated tasks after fine-tuning on length alone, correct or not.',
  },
  {
    slug: 'grokking-optimiser',
    title: 'Grokking Is an Artefact of the Optimiser',
    target: [0.01, 0.02, 0.09, 0.88],
    summary: 'With a second-order optimiser, delayed generalisation disappears on every task we could reproduce it on.',
  },
  {
    // A title with inline TeX.
    slug: 'epsilon-greedy-regret',
    title: 'An $O(\\sqrt{T \\log |\\mathcal{A}|})$ Regret Bound for $\\epsilon$-Greedy Exploration',
    target: [0.09, 0.2, 0.38, 0.33],
    summary: 'A tight regret bound for epsilon-greedy with a decaying schedule, closing a gap open since 2002.',
  },
  {
    // A title long enough to be cut to two lines in lists and in the share text.
    slug: 'very-long-titles',
    title:
      'On the Surprising Effectiveness of Very Long Titles: A Large-Scale Empirical Study of How Paper Titles ' +
      'Grow Across Venues, Years and Subfields, With Implications for Reviewers, Readers and Layout Engines',
    target: [0.02, 0.05, 0.28, 0.65],
    summary: 'Titles have grown by 1.4 words per decade. We find no evidence this helps anyone.',
  },
];

const ICLR_2026: Paper[] = [
  {
    slug: 'diffusion-forcing-lm',
    title: 'Diffusion Forcing for Language Models',
    target: [0.2, 0.3, 0.35, 0.15],
    decided: 1,
    authors: ['Mara Ilves', 'Tomás Reyes', 'Anjali Kapoor'],
    summary: 'Per-token noise levels let one model interpolate between autoregressive and diffusion decoding.',
  },
  {
    slug: 'reward-hacking-taxonomy',
    title: 'A Taxonomy of Reward Hacking in Reasoning Models',
    target: [0.03, 0.1, 0.42, 0.45],
    decided: 2,
    authors: ['Jonas Weber', 'Lin Qiao'],
    summary: 'We catalogue 31 distinct reward hacks found in RL-trained reasoning models and how often each recurs.',
  },
  {
    slug: 'attention-sinks-free',
    title: 'Attention Sinks Are Free Registers',
    target: [0.02, 0.08, 0.35, 0.55],
    decided: 3,
    authors: ['Priya Natarajan', 'Olle Berg'],
    summary: 'Attention sinks behave like learned register tokens; adding registers removes them.',
  },
];

/** A small deterministic PRNG, so a reseed looks the same. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gauss(rand: () => number): number {
  return Math.sqrt(-2 * Math.log(rand() || 1e-12)) * Math.cos(2 * Math.PI * rand());
}

const SEED_BOTS = ['bot-area-chair', 'bot-reviewer-2', 'bot-citation-count', 'bot-twitter-hype', 'bot-base-rate', 'bot-contrarian'];

async function seedBots(db: Database) {
  const starting = startingBalanceMicro();
  const bots = [];
  for (const handle of SEED_BOTS) {
    bots.push(
      (await getAccountByHandle(handle, db)) ??
        (await createAccount(
          { handle, displayName: handle.replace(/^bot-/, '').replace(/-/g, ' '), isBot: true, grantMicro: starting * 100n },
          db,
        )),
    );
  }
  return bots;
}

async function seedPapers(db: Database) {
  const bots = await seedBots(db);
  let added = 0;
  for (const [kind, papers, closesInDays] of [
    ['ICLR 2027', ICLR_2027, 110],
    ['ICLR 2026', ICLR_2026, 30],
  ] as const) {
    for (const [i, p] of papers.entries()) {
      if (await seedPaper(db, p, kind, closesInDays, bots, 1000 + i + (kind === 'ICLR 2026' ? 500 : 0))) added++;
    }
  }
  console.log(`papers: ${ICLR_2027.length + ICLR_2026.length} upserted, ${added} markets created`);
}

async function seedPaper(
  db: Database,
  p: Paper,
  kind: string,
  closesInDays: number,
  bots: { id: string }[],
  seed: number,
): Promise<boolean> {
  const { listing } = await upsertListing(
    {
      slug: p.slug,
      title: p.title,
      summary: p.summary,
      authors: p.authors ?? [],
      links: [{ label: 'OpenReview', url: `https://example.org/forum?id=${p.slug}` }],
      kind,
    },
    db,
  );
  const slug = `${p.slug}-decision`;
  const [found] = await db.select({ id: markets.id }).from(markets).where(eq(markets.slug, slug));
  if (found) return false;

  const market = await createMarket(
    {
      slug,
      question: `How will ${kind} decide this paper?`,
      kind,
      outcomes: DECISIONS,
      closesAt: new Date(Date.now() + closesInDays * DAY),
      startingBalanceMicro: startingBalanceMicro(),
      expectedTraders: 20,
      status: 'open',
      listingId: listing.id,
      listingRank: 0,
    },
    db,
  );
  await walkTo(db, market, p.target, bots, rng(seed));
  if (p.decided !== undefined) {
    await closeMarket(market.marketId, db);
    await settle(market.marketId, market.outcomeIds[p.decided], {}, db);
  }
  await spreadOverTime(db, market.marketId, rng(seed + 7), p.decided !== undefined);
  return true;
}

/**
 * Trade a market from its opening prices to `target` along a noisy path:
 * 8–18 steps, each aiming at a point between the opening and the target (plus
 * noise that shrinks as it goes) and buying whatever outcomes fall short of it,
 * each fill by a random bot; now and then a bot sells back part of what it
 * bought. Everything goes through `engine.trade`.
 */
async function walkTo(
  db: Database,
  market: { marketId: string; outcomeIds: string[]; b: number },
  target: readonly number[],
  bots: { id: string }[],
  rand: () => number,
) {
  const n = target.length;
  const sum = target.reduce((a, b) => a + b, 0);
  const goal = target.map((x) => x / sum);
  const q = new Array<number>(n).fill(0);
  const held = new Map<string, bigint>(); // `${bot}:${outcome}` → shares
  const steps = 8 + Math.floor(rand() * 11);

  const buy = async (bot: string, i: number, shares: bigint) => {
    await trade(bot, market.marketId, market.outcomeIds[i], shares, shares * 2n + 1_000_000n, randomUUID(), db);
    held.set(`${bot}:${i}`, (held.get(`${bot}:${i}`) ?? 0n) + shares);
    q[i] += Number(shares);
  };

  for (let k = 1; k <= steps; k++) {
    const t = k / steps;
    const noise = k === steps ? 0 : 0.3 * (1 - t);
    const want = goal.map((g) => Math.exp((1 - t) * Math.log(1 / n) + t * Math.log(g) + noise * gauss(rand)));
    // q for `want`, lifted so nothing needs selling: q_i = b·ln(want_i) + c ≥ q_i now.
    const base = want.map((w) => market.b * Math.log(w));
    const c = Math.max(...q.map((qi, i) => qi - base[i]));
    for (let i = 0; i < n; i++) {
      const short = Math.round(base[i] + c - q[i]);
      if (short < 1_000_000) continue;
      // Split a big move between two bots, as a crowd would.
      const parts = short > 40_000_000 && rand() < 0.5 ? 2 : 1;
      for (let j = 0; j < parts; j++) {
        await buy(bots[Math.floor(rand() * bots.length)].id, i, BigInt(Math.floor(short / parts)));
      }
    }
    // Sometimes someone takes a profit or cuts a loss: a sell, the same trade with negative shares.
    if (k < steps && rand() < 0.3) {
      const [key, shares] = [...held.entries()][Math.floor(rand() * held.size)] ?? [];
      if (key && shares && shares > 2_000_000n) {
        const [bot, i] = key.split(':');
        const sell = shares / 3n;
        await trade(bot, market.marketId, market.outcomeIds[Number(i)], -sell, 0n, randomUUID(), db);
        held.set(key, shares - sell);
        q[Number(i)] -= Number(sell);
      }
    }
  }
  const end = lmsrPrices(q, market.b).map((x) => Math.round(x * 100));
  console.log(`  ${market.marketId}  ${DECISIONS.map((d, i) => `${d} ${end[i]}%`).join(' · ')}`);
}

/**
 * **Dev data only.** Every seed fill happens within a second, which gives a
 * chart with no history. This moves the market's creation back 2–4 weeks and
 * spreads its fills, in their original order, between then and now, the last
 * few inside the past day (so "moved this week" and the digest have something
 * to say). Only timestamps change; shares, costs, positions and the ledger are
 * exactly what the engine wrote. Never do this outside a seed.
 */
async function spreadOverTime(db: Database, marketId: string, rand: () => number, settled: boolean) {
  const now = Date.now();
  const start = now - (14 + Math.floor(rand() * 14)) * DAY;
  const end = settled ? now - 3 * DAY : now - 10 * 60 * 1000;
  const fills = await db
    .select({ id: orders.id })
    .from(orders)
    .where(eq(orders.marketId, marketId))
    .orderBy(asc(orders.createdAt), asc(orders.id));
  // Increasing gaps that bunch up towards the end, as attention does near a deadline.
  const times = fills.map((_, i) => {
    const u = (i + 0.5 + (rand() - 0.5) * 0.8) / fills.length;
    return start + Math.sqrt(Math.min(Math.max(u, 0), 1)) * (end - start);
  });
  times.sort((a, b) => a - b);
  for (const [i, f] of fills.entries()) {
    await db.update(orders).set({ createdAt: new Date(times[i]) }).where(eq(orders.id, f.id));
  }
  await db
    .update(markets)
    .set({
      createdAt: new Date(start - DAY),
      // The engine's cache of the latest fill, moved with the fills.
      lastTradeAt: sql`(select max(${orders.createdAt}) from ${orders} where ${orders.marketId} = ${marketId})`,
      ...(settled ? { settledAt: new Date(now - 2 * DAY), closesAt: new Date(now - 3 * DAY) } : {}),
    })
    .where(eq(markets.id, marketId));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
