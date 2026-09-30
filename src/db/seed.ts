import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { asc, eq, sql } from 'drizzle-orm';
import { createAccount, createHouse, ensureAccountForUser, startingBalanceMicro } from '@/server/accounts';
import { createGroup, joinGroup } from '@/server/groups';
import { createAuth } from '@/server/better-auth';
import { closeMarket, createMarket, settle, trade } from '@/server/engine';
import { upsertListing } from '@/server/listings';
import { valuations } from '@/server/valuation';
import { costToTrade, prices as lmsrPrices } from '@/lib/lmsr';
import { createDb, createPool, type Database } from './index';
import { markets, orders } from './schema';

/**
 * A venue with something to look at (`npm run db:seed`). It **wipes every
 * table first**, users and sessions included, then creates:
 *
 * - the house;
 * - a field of seed bots, each funded exactly as a signup is;
 * - a few invented papers under `ICLR 2027`, each with the default single
 *   market — the four outcomes `Oral, Spotlight, Poster, Reject`, best first
 *   (issue #11 §4) — and one with a second, binary market (a paper can have
 *   more than one); plus a few `ICLR 2026` papers already settled;
 * - the admin, the first `ADMIN_EMAILS` address, funded as a signup is,
 *   running a group (#25) that a few of the bots have joined.
 *
 * The bots trade as a crowd would (`simulateCrowd`): each has noisy beliefs
 * about each paper and spends a slice of its own balance where it disagrees
 * with the price. Nobody gets extra reputation, so the field ends up spread
 * around the starting balance, and prices drift towards each paper's target
 * as far as the field can afford to push them.
 *
 * Only a local database is wiped unless `--allow-remote` is passed; a remote
 * seed also needs `SEED_ADMIN_PASSWORD` (a local one defaults to
 * `ADMIN_PASSWORD`).
 *
 * The titles are invented. The platform still knows nothing about papers:
 * everything here goes in through the same engine and listing calls a client
 * would make. The one exception is `spreadOverTime`, a seed-only rewrite of
 * fill timestamps so charts have a history — see there.
 */
async function main() {
  const url = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const local = isLocal(url);
  if (!local && !process.argv.includes('--allow-remote')) {
    throw new Error(`refusing to wipe ${new URL(url).hostname}: only a local database is seeded without --allow-remote`);
  }
  const adminPassword = process.env.SEED_ADMIN_PASSWORD || (local ? ADMIN_PASSWORD : '');
  if (!adminPassword) throw new Error('SEED_ADMIN_PASSWORD is required to seed a remote database');

  const pool = createPool(url);
  const db = createDb(pool);

  await wipeData(db);
  await createHouse(startingBalanceMicro() * 1000n, db);
  const bots = await seedBots(db);
  await seedPapers(db, bots);
  const admin = await seedAdmin(db, adminPassword);
  if (admin) await seedGroup(db, admin.id, bots);
  await report(db);
  await pool.end();
}

function isLocal(url: string): boolean {
  return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(url).hostname);
}

/** Empties every table in `public` (users and sessions included) so the seed starts from nothing. */
async function wipeData(db: Database) {
  const { rows } = await db.execute<{ t: string }>(
    sql`select format('%I', tablename) as t from pg_tables where schemaname = 'public'`,
  );
  if (rows.length > 0) {
    await db.execute(sql.raw(`truncate table ${rows.map((r) => r.t).join(', ')} restart identity cascade`));
  }
  console.log(`wiped ${rows.length} tables`);
}

/** Default password of the seeded admin on a local database. */
const ADMIN_PASSWORD = 'testtesttest';

/**
 * A confirmed, funded user for the first `ADMIN_EMAILS` address, who can sign
 * in with `password`. Inserted through Better Auth's own adapter, so the
 * password hash is its format, but past the sign-up hook and the confirmation
 * mail.
 */
async function seedAdmin(db: Database, password: string) {
  const email = (process.env.ADMIN_EMAILS ?? '').split(',')[0]?.trim().toLowerCase();
  if (!email) {
    console.log('ADMIN_EMAILS is empty; no admin user seeded');
    return null;
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
    password: await ctx.password.hash(password),
  });
  const account = await ensureAccountForUser({ id: user.id, name: user.name, email }, db);
  const shown = password === ADMIN_PASSWORD ? ` password ${password}` : '';
  console.log(`admin       ${email}  (${account.handle})${shown}`);
  return account;
}

/** A group the admin runs, joined by every third bot, through `server/groups.ts` as the API would. */
async function seedGroup(db: Database, adminId: string, bots: Bot[]) {
  const group = await createGroup(adminId, { name: 'Reading group', description: 'Papers we argued about on Thursdays.' }, db);
  for (const bot of bots.filter((_, i) => i % 3 === 0)) await joinGroup(bot.id, group.inviteCode, db);
  console.log(`group       ${group.name}  /groups/join?code=${group.inviteCode}`);
}

/** Every trader's net worth, so a seed shows at a glance that the field is level. */
async function report(db: Database) {
  const fmt = (micro: bigint) => (Number(micro) / 1e6).toFixed(0).padStart(6);
  const rows = [...(await valuations(undefined, db)).values()].sort((a, b) => Number(b.netWorthMicro - a.netWorthMicro));
  for (const v of rows) {
    console.log(
      `  ${v.account.handle.padEnd(22)} net worth ${fmt(v.netWorthMicro)}  (cash ${fmt(v.cashMicro)}, ` +
        `holdings ${fmt(v.holdingsValueMicro)}, realized ${fmt(v.realizedPnlMicro)})`,
    );
  }
}

// ---------------------------------------------------------------------------
// papers
// ---------------------------------------------------------------------------

/** The four outcomes of a paper's market, best first; the headline is 1 − P(Reject). */
const DECISIONS = ['Oral', 'Spotlight', 'Poster', 'Reject'];
/**
 * The decision market's resolution rule, shown under the question. Reject is
 * every way a paper can fail to appear (#19): the client that settles the
 * market settles a withdrawal as Reject.
 */
const DECISION_RULE = 'Reject also covers a paper that is withdrawn or desk-rejected before the decision.';
const DAY = 24 * 60 * 60 * 1000;

interface Paper {
  slug: string;
  title: string;
  /** Where the crowd's beliefs drift to, best first: oral, spotlight, poster, reject. Normalised on use. */
  target: [number, number, number, number];
  summary: string;
  /** Only once deanonymised, i.e. after the decision. */
  authors?: string[];
  /** Settled papers: the decision (index into DECISIONS). */
  decided?: number;
  /** A second, binary market on the same listing: where the crowd's P(award) drifts to. */
  award?: number;
}

const ICLR_2027: Paper[] = [
  {
    slug: 'sparse-moe-sublinear',
    title: 'Sparse Mixtures of Experts Scale Sublinearly in Active Parameters',
    target: [0.07, 0.18, 0.42, 0.33],
    award: 0.12,
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

function normalise(xs: number[]): number[] {
  const sum = xs.reduce((a, b) => a + b, 0);
  return xs.map((x) => x / sum);
}

/** The seed field. Also the markets' `expectedTraders`, so `b` is sized for exactly this crowd. */
const SEED_BOTS = [
  'bot-area-chair',
  'bot-reviewer-2',
  'bot-citation-count',
  'bot-twitter-hype',
  'bot-base-rate',
  'bot-contrarian',
  'bot-arxiv-watcher',
  'bot-scaling-believer',
  'bot-theory-purist',
  'bot-benchmark-skeptic',
  'bot-late-reviewer',
  'bot-first-author',
];

interface Bot {
  id: string;
  handle: string;
  /** How far its beliefs stray from the crowd's signal: a sharp bot profits, a noisy one pays for it. */
  noise: number;
  /** Cash, in micro-units, as of the bot's last fill. */
  cash: number;
  /** Shares held, in micro-units, by outcome id. */
  held: Map<string, number>;
}

/** Each bot funded exactly as a signup is. */
async function seedBots(db: Database): Promise<Bot[]> {
  const rand = rng(7);
  const bots: Bot[] = [];
  for (const handle of SEED_BOTS) {
    const account = await createAccount(
      { handle, displayName: handle.replace(/^bot-/, '').replace(/-/g, ' '), isBot: true },
      db,
    );
    bots.push({
      id: account.id,
      handle,
      noise: 0.15 + 0.5 * rand(),
      cash: Number(account.balanceMicro),
      held: new Map(),
    });
  }
  return bots;
}

/** A market as the crowd simulation sees it: `q` and `b` in micro-units, as the engine returns them. */
interface Board {
  marketId: string;
  outcomeIds: string[];
  b: number;
  q: number[];
  /** Where beliefs drift to, normalised. */
  goal: number[];
  /** Settled markets: the winning index. */
  decided?: number;
  rand: () => number;
}

async function seedPapers(db: Database, bots: Bot[]) {
  const boards: Board[] = [];
  for (const [kind, papers, closesInDays] of [
    ['ICLR 2027', ICLR_2027, 110],
    ['ICLR 2026', ICLR_2026, 30],
  ] as const) {
    for (const [i, p] of papers.entries()) {
      boards.push(...(await seedPaper(db, p, kind, closesInDays, 1000 + i + (kind === 'ICLR 2026' ? 500 : 0))));
    }
  }
  await simulateCrowd(db, boards, bots, rng(42));

  for (const board of boards) {
    const settled = board.decided !== undefined;
    if (settled) {
      await closeMarket(board.marketId, db);
      await settle(board.marketId, board.outcomeIds[board.decided!], {}, db);
    }
    await spreadOverTime(db, board.marketId, board.rand, settled);
    const end = lmsrPrices(board.q, board.b).map((x) => Math.round(x * 100));
    console.log(`  ${board.marketId}  ${end.map((x) => `${x}%`).join(' · ')}`);
  }
  console.log(`papers: ${ICLR_2027.length + ICLR_2026.length}, markets: ${boards.length}`);
}

async function seedPaper(
  db: Database,
  p: Paper,
  kind: string,
  closesInDays: number,
  seed: number,
): Promise<Board[]> {
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
  const common = {
    kind,
    closesAt: new Date(Date.now() + closesInDays * DAY),
    startingBalanceMicro: startingBalanceMicro(),
    expectedTraders: SEED_BOTS.length,
    status: 'open' as const,
    listingId: listing.id,
  };

  const decision = await createMarket(
    {
      ...common,
      slug: `${p.slug}-decision`,
      question: `How will ${kind} decide this paper?`,
      description: DECISION_RULE,
      outcomes: DECISIONS,
      listingRank: 0,
    },
    db,
  );
  const boards: Board[] = [
    {
      ...decision,
      q: new Array(DECISIONS.length).fill(0),
      goal: normalise(p.target),
      decided: p.decided,
      rand: rng(seed),
    },
  ];

  if (p.award !== undefined) {
    const award = await createMarket(
      {
        ...common,
        slug: `${p.slug}-award`,
        question: 'Will this paper win an outstanding paper award?',
        outcomes: ['YES', 'NO'],
        listingRank: 1,
      },
      db,
    );
    boards.push({ ...award, q: [0, 0], goal: [p.award, 1 - p.award], rand: rng(seed + 100) });
  }
  return boards;
}

/** Rounds of trading; each market sees a few bots per round. */
const ROUNDS = 14;

/**
 * The bots trade every market over `ROUNDS` rounds, interleaved so no market
 * gets first call on the field's money. Everything goes through `engine.trade`.
 *
 * Each market has a signal that drifts from uniform to its goal, plus news
 * noise that shrinks as it goes. Each round a few bots look at it; a bot's
 * belief is the signal plus its own noise. It buys the outcome it thinks most
 * underpriced, moving the price halfway to its belief, with at most a slice of
 * its current cash — so nobody runs dry and no one bot can pin a price. Now
 * and then, it sells back part of a holding it now thinks overpriced.
 */
async function simulateCrowd(db: Database, boards: Board[], bots: Bot[], rand: () => number) {
  for (let r = 1; r <= ROUNDS; r++) {
    const t = r / ROUNDS;
    for (const board of shuffle(boards, rand)) {
      const n = board.goal.length;
      const news = 0.35 * (1 - t);
      const signal = normalise(
        board.goal.map((g) => Math.exp((1 - t) * Math.log(1 / n) + t * Math.log(g) + news * gauss(board.rand))),
      );
      const traders = shuffle(bots, rand).slice(0, 1 + Math.floor(rand() * 3));
      for (const bot of traders) {
        const belief = normalise(signal.map((s) => s * Math.exp(bot.noise * gauss(rand))));
        const price = lmsrPrices(board.q, board.b);
        if (!(await maybeSell(db, board, bot, belief, price))) {
          await maybeBuy(db, board, bot, belief, price, rand);
        }
      }
    }
  }
}

async function maybeBuy(db: Database, board: Board, bot: Bot, belief: number[], price: number[], rand: () => number) {
  let i = 0;
  for (let k = 1; k < price.length; k++) if (belief[k] / price[k] > belief[i] / price[i]) i = k;
  if (belief[i] < price[i] * 1.05) return;

  // Shares that move p_i to `aim`: with e_k = exp(q_k / b) and Z = Σ e_k,
  // Δ = b·ln(aim·(Z − e_i) / ((1 − aim)·e_i)).
  const aim = price[i] + 0.5 * (belief[i] - price[i]);
  const top = Math.max(...board.q);
  const e = board.q.map((q) => Math.exp((q - top) / board.b));
  const z = e.reduce((a, b) => a + b, 0);
  let shares = board.b * Math.log((aim * (z - e[i])) / ((1 - aim) * e[i]));
  // At most a slice of its cash; cost is convex in shares, so scaling them down keeps it under.
  const stake = bot.cash * (0.04 + 0.08 * rand());
  const cost = costToTrade(board.q, i, shares, board.b);
  if (cost > stake) shares *= stake / cost;
  shares = Math.floor(shares);
  if (shares < 1_000_000) return;

  const maxCost = Math.ceil(costToTrade(board.q, i, shares, board.b)) + 1_000;
  if (maxCost > bot.cash) return;
  await fill(db, board, bot, i, shares, BigInt(maxCost));
}

/** Sells a third of a holding the bot now thinks is overpriced by more than 10%. */
async function maybeSell(db: Database, board: Board, bot: Bot, belief: number[], price: number[]): Promise<boolean> {
  for (let i = 0; i < price.length; i++) {
    const held = bot.held.get(board.outcomeIds[i]) ?? 0;
    if (held > 3_000_000 && price[i] > belief[i] * 1.1) {
      await fill(db, board, bot, i, -Math.floor(held / 3), 0n);
      return true;
    }
  }
  return false;
}

async function fill(db: Database, board: Board, bot: Bot, i: number, shares: number, maxCost: bigint) {
  const outcomeId = board.outcomeIds[i];
  const done = await trade(bot.id, board.marketId, outcomeId, BigInt(shares), maxCost, randomUUID(), db);
  board.q[i] += shares;
  bot.cash = Number(done.balanceAfterMicro);
  bot.held.set(outcomeId, Number(done.positionAfterMicro));
}

function shuffle<T>(xs: readonly T[], rand: () => number): T[] {
  const out = xs.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * **Seed data only.** Every seed fill happens within a second, which gives a
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
