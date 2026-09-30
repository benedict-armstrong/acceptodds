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
 *   more than one);
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
 * The papers are real (arXiv, often historical), posed as ICLR submissions;
 * the decisions and awards are invented. The platform still knows nothing about papers:
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
  /** The paper's arXiv id: the listing links its abstract page and its PDF. */
  arxiv: string;
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
    slug: 'attention-is-all-you-need',
    title: 'Attention Is All You Need',
    arxiv: '1706.03762',
    target: [0.35, 0.3, 0.3, 0.05],
    award: 0.3,
    summary:
      'The dominant sequence transduction models are based on complex recurrent or convolutional neural ' +
      'networks in an encoder-decoder configuration. The best performing models also connect the encoder and ' +
      'decoder through an attention mechanism. We propose a new simple network architecture, the Transformer, ' +
      'based solely on attention mechanisms, dispensing with recurrence and convolutions entirely. Experiments ' +
      'on two machine translation tasks show these models to be superior in quality while being more ' +
      'parallelizable and requiring significantly less time to train. Our model achieves 28.4 BLEU on the WMT ' +
      '2014 English-to-German translation task, improving over the existing best results, including ensembles ' +
      'by over 2 BLEU. On the WMT 2014 English-to-French translation task, our model establishes a new single-' +
      'model state-of-the-art BLEU score of 41.8 after training for 3.5 days on eight GPUs, a small fraction of' +
      ' the training costs of the best models from the literature. We show that the Transformer generalizes ' +
      'well to other tasks by applying it successfully to English constituency parsing both with large and ' +
      'limited training data.',
  },
  {
    slug: 'lora',
    title: 'LoRA: Low-Rank Adaptation of Large Language Models',
    arxiv: '2106.09685',
    target: [0.12, 0.28, 0.45, 0.15],
    summary:
      'An important paradigm of natural language processing consists of large-scale pre-training on general ' +
      'domain data and adaptation to particular tasks or domains. As we pre-train larger models, full fine-' +
      'tuning, which retrains all model parameters, becomes less feasible. Using GPT-3 175B as an example -- ' +
      'deploying independent instances of fine-tuned models, each with 175B parameters, is prohibitively ' +
      'expensive. We propose Low-Rank Adaptation, or LoRA, which freezes the pre-trained model weights and ' +
      'injects trainable rank decomposition matrices into each layer of the Transformer architecture, greatly ' +
      'reducing the number of trainable parameters for downstream tasks. Compared to GPT-3 175B fine-tuned with' +
      ' Adam, LoRA can reduce the number of trainable parameters by 10,000 times and the GPU memory requirement' +
      ' by 3 times. LoRA performs on-par or better than fine-tuning in model quality on RoBERTa, DeBERTa, ' +
      'GPT-2, and GPT-3, despite having fewer trainable parameters, a higher training throughput, and, unlike ' +
      'adapters, no additional inference latency. We also provide an empirical investigation into rank-' +
      'deficiency in language model adaptation, which sheds light on the efficacy of LoRA. We release a package' +
      ' that facilitates the integration of LoRA with PyTorch models and provide our implementations and model ' +
      'checkpoints for RoBERTa, DeBERTa, and GPT-2 at https://github.com/microsoft/LoRA.',
  },
  {
    slug: 'scaling-laws-neural-lms',
    title: 'Scaling Laws for Neural Language Models',
    arxiv: '2001.08361',
    target: [0.1, 0.22, 0.4, 0.28],
    summary:
      'We study empirical scaling laws for language model performance on the cross-entropy loss. The loss ' +
      'scales as a power-law with model size, dataset size, and the amount of compute used for training, with ' +
      'some trends spanning more than seven orders of magnitude. Other architectural details such as network ' +
      'width or depth have minimal effects within a wide range. Simple equations govern the dependence of ' +
      'overfitting on model/dataset size and the dependence of training speed on model size. These ' +
      'relationships allow us to determine the optimal allocation of a fixed compute budget. Larger models are ' +
      'significantly more sample-efficient, such that optimally compute-efficient training involves training ' +
      'very large models on a relatively modest amount of data and stopping significantly before convergence.',
  },
  {
    slug: 'lottery-ticket-hypothesis',
    title: 'The Lottery Ticket Hypothesis: Finding Sparse, Trainable Neural Networks',
    arxiv: '1803.03635',
    target: [0.08, 0.2, 0.42, 0.3],
    summary:
      'Neural network pruning techniques can reduce the parameter counts of trained networks by over 90%, ' +
      'decreasing storage requirements and improving computational performance of inference without ' +
      'compromising accuracy. However, contemporary experience is that the sparse architectures produced by ' +
      'pruning are difficult to train from the start, which would similarly improve training performance. We ' +
      'find that a standard pruning technique naturally uncovers subnetworks whose initializations made them ' +
      'capable of training effectively. Based on these results, we articulate the "lottery ticket hypothesis:" ' +
      'dense, randomly-initialized, feed-forward networks contain subnetworks ("winning tickets") that - when ' +
      'trained in isolation - reach test accuracy comparable to the original network in a similar number of ' +
      'iterations. The winning tickets we find have won the initialization lottery: their connections have ' +
      'initial weights that make training particularly effective. We present an algorithm to identify winning ' +
      'tickets and a series of experiments that support the lottery ticket hypothesis and the importance of ' +
      'these fortuitous initializations. We consistently find winning tickets that are less than 10-20% of the ' +
      'size of several fully-connected and convolutional feed-forward architectures for MNIST and CIFAR10. ' +
      'Above this size, the winning tickets that we find learn faster than the original network and reach ' +
      'higher test accuracy.',
  },
  {
    slug: 'rethinking-generalization',
    title: 'Understanding Deep Learning Requires Rethinking Generalization',
    arxiv: '1611.03530',
    target: [0.06, 0.16, 0.36, 0.42],
    summary:
      'Despite their massive size, successful deep artificial neural networks can exhibit a remarkably small ' +
      'difference between training and test performance. Conventional wisdom attributes small generalization ' +
      'error either to properties of the model family, or to the regularization techniques used during ' +
      'training. Through extensive systematic experiments, we show how these traditional approaches fail to ' +
      'explain why large neural networks generalize well in practice. Specifically, our experiments establish ' +
      'that state-of-the-art convolutional networks for image classification trained with stochastic gradient ' +
      'methods easily fit a random labeling of the training data. This phenomenon is qualitatively unaffected ' +
      'by explicit regularization, and occurs even if we replace the true images by completely unstructured ' +
      'random noise. We corroborate these experimental findings with a theoretical construction showing that ' +
      'simple depth two neural networks already have perfect finite sample expressivity as soon as the number ' +
      'of parameters exceeds the number of data points as it usually does in practice. We interpret our ' +
      'experimental findings by comparison with traditional models.',
  },
  {
    slug: 'mamba',
    title: 'Mamba: Linear-Time Sequence Modeling with Selective State Spaces',
    arxiv: '2312.00752',
    target: [0.05, 0.14, 0.37, 0.44],
    summary:
      'Foundation models, now powering most of the exciting applications in deep learning, are almost ' +
      'universally based on the Transformer architecture and its core attention module. Many subquadratic-time ' +
      'architectures such as linear attention, gated convolution and recurrent models, and structured state ' +
      'space models (SSMs) have been developed to address Transformers\' computational inefficiency on long ' +
      'sequences, but they have not performed as well as attention on important modalities such as language. We' +
      ' identify that a key weakness of such models is their inability to perform content-based reasoning, and ' +
      'make several improvements. First, simply letting the SSM parameters be functions of the input addresses ' +
      'their weakness with discrete modalities, allowing the model to selectively propagate or forget ' +
      'information along the sequence length dimension depending on the current token. Second, even though this' +
      ' change prevents the use of efficient convolutions, we design a hardware-aware parallel algorithm in ' +
      'recurrent mode. We integrate these selective SSMs into a simplified end-to-end neural network ' +
      'architecture without attention or even MLP blocks (Mamba). Mamba enjoys fast inference (5$\\times$ higher' +
      ' throughput than Transformers) and linear scaling in sequence length, and its performance improves on ' +
      'real data up to million-length sequences. As a general sequence model backbone, Mamba achieves state-of-' +
      'the-art performance across several modalities such as language, audio, and genomics. On language ' +
      'modeling, our Mamba-3B model outperforms Transformers of the same size and matches Transformers twice ' +
      'its size, both in pretraining and downstream evaluation.',
  },
  {
    // A title with inline TeX.
    slug: 'infinity-former',
    title: '$\\infty$-former: Infinite Memory Transformer',
    arxiv: '2109.00301',
    target: [0.02, 0.06, 0.3, 0.62],
    summary:
      'Transformers are unable to model long-term memories effectively, since the amount of computation they ' +
      'need to perform grows with the context length. While variations of efficient transformers have been ' +
      'proposed, they all have a finite memory capacity and are forced to drop old information. In this paper, ' +
      'we propose the $\\infty$-former, which extends the vanilla transformer with an unbounded long-term ' +
      'memory. By making use of a continuous-space attention mechanism to attend over the long-term memory, the' +
      ' $\\infty$-former\'s attention complexity becomes independent of the context length, trading off memory ' +
      'length with precision. In order to control where precision is more important, $\\infty$-former maintains ' +
      '"sticky memories" being able to model arbitrarily long contexts while keeping the computation budget ' +
      'fixed. Experiments on a synthetic sorting task, language modeling, and document grounded dialogue ' +
      'generation demonstrate the $\\infty$-former\'s ability to retain information from long sequences.',
  },
  {
    // A title long enough to be cut to two lines in lists and in the share text.
    slug: 't5',
    title: 'Exploring the Limits of Transfer Learning with a Unified Text-to-Text Transformer',
    arxiv: '1910.10683',
    target: [0.07, 0.18, 0.45, 0.3],
    summary:
      'Transfer learning, where a model is first pre-trained on a data-rich task before being fine-tuned on a ' +
      'downstream task, has emerged as a powerful technique in natural language processing (NLP). The ' +
      'effectiveness of transfer learning has given rise to a diversity of approaches, methodology, and ' +
      'practice. In this paper, we explore the landscape of transfer learning techniques for NLP by introducing' +
      ' a unified framework that converts all text-based language problems into a text-to-text format. Our ' +
      'systematic study compares pre-training objectives, architectures, unlabeled data sets, transfer ' +
      'approaches, and other factors on dozens of language understanding tasks. By combining the insights from ' +
      'our exploration with scale and our new ``Colossal Clean Crawled Corpus\'\', we achieve state-of-the-art ' +
      'results on many benchmarks covering summarization, question answering, text classification, and more. To' +
      ' facilitate future work on transfer learning for NLP, we release our data set, pre-trained models, and ' +
      'code.',
  },
  {
    slug: 'ddpm',
    title: 'Denoising Diffusion Probabilistic Models',
    arxiv: '2006.11239',
    target: [0.15, 0.3, 0.4, 0.15],
    summary:
      'We present high quality image synthesis results using diffusion probabilistic models, a class of latent ' +
      'variable models inspired by considerations from nonequilibrium thermodynamics. Our best results are ' +
      'obtained by training on a weighted variational bound designed according to a novel connection between ' +
      'diffusion probabilistic models and denoising score matching with Langevin dynamics, and our models ' +
      'naturally admit a progressive lossy decompression scheme that can be interpreted as a generalization of ' +
      'autoregressive decoding. On the unconditional CIFAR10 dataset, we obtain an Inception score of 9.46 and ' +
      'a state-of-the-art FID score of 3.17. On 256x256 LSUN, we obtain sample quality similar to ' +
      'ProgressiveGAN. Our implementation is available at https://github.com/hojonathanho/diffusion',
  },
  {
    slug: 'grokking',
    title: 'Grokking: Generalization Beyond Overfitting on Small Algorithmic Datasets',
    arxiv: '2201.02177',
    target: [0.01, 0.04, 0.2, 0.75],
    summary:
      'In this paper we propose to study generalization of neural networks on small algorithmically generated ' +
      'datasets. In this setting, questions about data efficiency, memorization, generalization, and speed of ' +
      'learning can be studied in great detail. In some situations we show that neural networks learn through a' +
      ' process of "grokking" a pattern in the data, improving generalization performance from random chance ' +
      'level to perfect generalization, and that this improvement in generalization can happen well past the ' +
      'point of overfitting. We also study generalization as a function of dataset size and find that smaller ' +
      'datasets require increasing amounts of optimization for generalization. We argue that these datasets ' +
      'provide a fertile ground for studying a poorly understood aspect of deep learning: generalization of ' +
      'overparametrized neural networks beyond memorization of the finite training dataset.',
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
  for (const [i, p] of ICLR_2027.entries()) {
    boards.push(...(await seedPaper(db, p, 'ICLR 2027', 110, 1000 + i)));
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
  console.log(`papers: ${ICLR_2027.length}, markets: ${boards.length}`);
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
      links: [
        { label: 'arXiv', url: `https://arxiv.org/abs/${p.arxiv}` },
        { label: 'PDF', url: `https://arxiv.org/pdf/${p.arxiv}` },
      ],
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
