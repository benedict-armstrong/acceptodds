import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { asc, eq, sql } from 'drizzle-orm';
import { createAccount, createHouse, ensureAccountForUser, startingBalanceMicro } from '@/server/accounts';
import { backComment } from '@/server/backings';
import { postComment } from '@/server/comments';
import { createGroup, joinGroup } from '@/server/groups';
import { createAuth } from '@/server/better-auth';
import { closeMarket, createMarket, settle, trade } from '@/server/engine';
import { upsertListing, type ReferenceInput } from '@/server/listings';
import { valuations } from '@/server/valuation';
import { costToTrade, prices as lmsrPrices } from '@/lib/lmsr';
import { createDb, createPool, type Database } from './index';
import { comments, markets, orders } from './schema';

/**
 * A venue with something to look at (`npm run db:seed`). It **wipes every
 * table first**, users and sessions included, then creates:
 *
 * - the house;
 * - a field of seed bots, each funded exactly as a signup is;
 * - fifty papers under `ICLR 2027`, each with the default single market —
 *   the four outcomes `Oral, Spotlight, Poster, Reject`, best first (issue
 *   #11 §4) — and one with a second, binary market (a paper can have more
 *   than one); each paper is listed `COPIES` times, so the list runs to
 *   several pages;
 * - a few bot comments on some of them, backed by other bots holding the
 *   same outcome (`seedComments`);
 * - the admin, the first `ADMIN_EMAILS` address, funded as a signup is,
 *   running a group (#25) that a few of the bots have joined.
 *
 * The bots trade as a crowd would (`simulateCrowd`): each has noisy beliefs
 * about each paper and spends a slice of its own balance where it disagrees
 * with the price. Nobody gets extra reputation, so the field ends up spread
 * around the starting balance, and prices drift towards each paper's target
 * as far as the field can afford to push them.
 *
 * `--empty` stops after the house and the admin: no bots, papers or group, for
 * a venue loaded from outside (`../scraping`). `--treasury=<REP>` sizes the
 * house, which pays every market's `b·ln(n)` and so bounds how many it can
 * open (about 1,200 REP each at the defaults).
 *
 * Only a local database is wiped unless `--allow-remote` is passed; a remote
 * seed also needs `SEED_ADMIN_PASSWORD` (a local one defaults to
 * `ADMIN_PASSWORD`).
 *
 * The papers are real (arXiv, often historical), posed as ICLR submissions;
 * the decisions and awards are invented. The platform still knows nothing about papers:
 * everything here goes in through the same engine and listing calls a client
 * would make. The one exception is `spreadOverTime`, a seed-only rewrite of
 * fill and comment timestamps so charts have a history — see there.
 */
async function main() {
  const url = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const local = isLocal(url);
  if (!local && !process.argv.includes('--allow-remote')) {
    throw new Error(
      `refusing to wipe ${new URL(url).hostname}: only a local database is seeded without --allow-remote`,
    );
  }
  const adminPassword = process.env.SEED_ADMIN_PASSWORD || (local ? ADMIN_PASSWORD : '');
  if (!adminPassword) throw new Error('SEED_ADMIN_PASSWORD is required to seed a remote database');

  const pool = createPool(url);
  const db = createDb(pool);

  await wipeData(db);
  const treasuryRep = process.argv.find((a) => a.startsWith('--treasury='))?.slice('--treasury='.length);
  await createHouse(treasuryRep ? BigInt(treasuryRep) * 1_000_000n : startingBalanceMicro() * 1000n, db);
  const empty = process.argv.includes('--empty');
  const bots = empty ? [] : await seedBots(db);
  if (!empty) await seedPapers(db, bots);
  const admin = await seedAdmin(db, adminPassword);
  if (admin && !empty) await seedGroup(db, admin.id, bots);
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
  const group = await createGroup(
    adminId,
    { name: 'Reading group', description: 'Papers we argued about on Thursdays.' },
    db,
  );
  for (const bot of bots.filter((_, i) => i % 3 === 0)) await joinGroup(bot.id, group.inviteCode, db);
  console.log(`group       ${group.name}  /groups/join?code=${group.inviteCode}`);
}

/** Every trader's net worth, so a seed shows at a glance that the field is level. */
async function report(db: Database) {
  const fmt = (micro: bigint) => (Number(micro) / 1e6).toFixed(0).padStart(6);
  const rows = [...(await valuations(undefined, db)).values()].sort((a, b) =>
    Number(b.netWorthMicro - a.netWorthMicro),
  );
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
 * The decision market's contract, shown to traders on its page. Reject is
 * every way a paper can fail to appear (#19): the client that settles the
 * market settles a withdrawal as Reject.
 */
const DECISION_CONTRACT = [
  "This market settles on the venue's final decision for the paper.",
  '',
  '- **Oral, Spotlight, Poster**: the paper is accepted in that form.',
  '- **Reject**: the paper is rejected. This also covers a paper that is withdrawn or desk-rejected before the decision.',
].join('\n');
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
      "space models (SSMs) have been developed to address Transformers' computational inefficiency on long " +
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
      " $\\infty$-former's attention complexity becomes independent of the context length, trading off memory " +
      'length with precision. In order to control where precision is more important, $\\infty$-former maintains ' +
      '"sticky memories" being able to model arbitrarily long contexts while keeping the computation budget ' +
      'fixed. Experiments on a synthetic sorting task, language modeling, and document grounded dialogue ' +
      "generation demonstrate the $\\infty$-former's ability to retain information from long sequences.",
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
      "our exploration with scale and our new ``Colossal Clean Crawled Corpus'', we achieve state-of-the-art " +
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

/**
 * More of the venue, enough to page through (50 a page): real arXiv papers
 * with a one-sentence summary each rather than the abstract, and a target
 * drawn from one number, `quality` (≈ P(accepted)), by {@link targetFor}.
 */
const MORE_PAPERS: [slug: string, title: string, arxiv: string, quality: number, summary: string][] = [
  [
    'resnet',
    'Deep Residual Learning for Image Recognition',
    '1512.03385',
    0.9,
    'Residual connections let networks hundreds of layers deep train as easily as shallow ones, and win ImageNet 2015.',
  ],
  [
    'adam',
    'Adam: A Method for Stochastic Optimization',
    '1412.6980',
    0.85,
    'An optimizer with per-parameter step sizes from estimates of the first and second moments of the gradient.',
  ],
  [
    'batch-norm',
    'Batch Normalization: Accelerating Deep Network Training by Reducing Internal Covariate Shift',
    '1502.03167',
    0.8,
    "Normalising each layer's inputs over the mini-batch allows much higher learning rates and acts as a regulariser.",
  ],
  [
    'gan',
    'Generative Adversarial Networks',
    '1406.2661',
    0.85,
    'A generator and a discriminator trained against each other in a minimax game learn to produce samples from the data distribution.',
  ],
  [
    'vae',
    'Auto-Encoding Variational Bayes',
    '1312.6114',
    0.8,
    'A reparameterisation of the variational lower bound makes it differentiable, so latent-variable models can be trained by stochastic gradient descent.',
  ],
  [
    'bert',
    'BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding',
    '1810.04805',
    0.85,
    'A Transformer encoder pre-trained with masked language modelling and next-sentence prediction, fine-tuned with one extra layer per task.',
  ],
  [
    'gpt-3',
    'Language Models are Few-Shot Learners',
    '2005.14165',
    0.75,
    'A 175B-parameter language model performs many tasks from a handful of examples in its prompt, with no gradient updates.',
  ],
  [
    'vit',
    'An Image is Worth 16x16 Words: Transformers for Image Recognition at Scale',
    '2010.11929',
    0.8,
    'A plain Transformer over sequences of image patches matches convolutional networks when pre-trained on enough data.',
  ],
  [
    'clip',
    'Learning Transferable Visual Models From Natural Language Supervision',
    '2103.00020',
    0.8,
    'Contrastive pre-training on 400M image–text pairs gives zero-shot classifiers competitive with supervised baselines.',
  ],
  [
    'word2vec',
    'Efficient Estimation of Word Representations in Vector Space',
    '1301.3781',
    0.55,
    'Two simple log-linear architectures learn word vectors from billions of words in hours, capturing syntactic and semantic regularities.',
  ],
  [
    'seq2seq',
    'Sequence to Sequence Learning with Neural Networks',
    '1409.3215',
    0.75,
    'An LSTM encodes a sentence into a vector and another decodes it, reaching strong translation results; reversing the source helps.',
  ],
  [
    'bahdanau-attention',
    'Neural Machine Translation by Jointly Learning to Align and Translate',
    '1409.0473',
    0.8,
    'Letting the decoder soft-search over source positions removes the fixed-length bottleneck of encoder–decoder translation.',
  ],
  [
    'u-net',
    'U-Net: Convolutional Networks for Biomedical Image Segmentation',
    '1505.04597',
    0.6,
    'A contracting path and a symmetric expanding path with skip connections segment biomedical images from very few annotations.',
  ],
  [
    'dcgan',
    'Unsupervised Representation Learning with Deep Convolutional Generative Adversarial Networks',
    '1511.06434',
    0.7,
    'Architectural constraints that make convolutional GANs train stably, and evidence that their features are useful.',
  ],
  [
    'wgan',
    'Wasserstein GAN',
    '1701.07875',
    0.65,
    'Training the critic to estimate the Earth-Mover distance gives GANs meaningful loss curves and more stable training.',
  ],
  [
    'layer-norm',
    'Layer Normalization',
    '1607.06450',
    0.45,
    "Normalising over a layer's units instead of the batch works for recurrent networks and at batch size one.",
  ],
  [
    'gcn',
    'Semi-Supervised Classification with Graph Convolutional Networks',
    '1609.02907',
    0.75,
    'A first-order approximation of spectral graph convolutions gives a simple, scalable layer for node classification.',
  ],
  [
    'gat',
    'Graph Attention Networks',
    '1710.10903',
    0.7,
    "Masked self-attention over a node's neighbours weights them without costly matrix operations or knowing the graph up front.",
  ],
  [
    'dqn',
    'Playing Atari with Deep Reinforcement Learning',
    '1312.5602',
    0.6,
    'A convolutional network trained with Q-learning from raw pixels learns to play seven Atari games, beating humans on three.',
  ],
  [
    'ppo',
    'Proximal Policy Optimization Algorithms',
    '1707.06347',
    0.4,
    "A clipped surrogate objective gives most of TRPO's stability with first-order optimisation and minibatch updates.",
  ],
  [
    'distillation',
    'Distilling the Knowledge in a Neural Network',
    '1503.02531',
    0.35,
    "A small model trained on an ensemble's softened outputs recovers much of its accuracy.",
  ],
  [
    'maml',
    'Model-Agnostic Meta-Learning for Fast Adaptation of Deep Networks',
    '1703.03400',
    0.7,
    'Learning an initialisation from which a few gradient steps solve a new task, for any model trained by gradient descent.',
  ],
  [
    'neural-ode',
    'Neural Ordinary Differential Equations',
    '1806.07366',
    0.85,
    'Parameterising the derivative of the hidden state with a network, and backpropagating through a black-box ODE solver.',
  ],
  [
    'stylegan',
    'A Style-Based Generator Architecture for Generative Adversarial Networks',
    '1812.04948',
    0.75,
    'A generator steered by per-layer styles separates high-level attributes from stochastic detail in generated faces.',
  ],
  [
    'score-sde',
    'Score-Based Generative Modeling through Stochastic Differential Equations',
    '2011.13456',
    0.85,
    'Diffusion and score matching unified as reversing an SDE, with exact likelihoods via the probability-flow ODE.',
  ],
  [
    'latent-diffusion',
    'High-Resolution Image Synthesis with Latent Diffusion Models',
    '2112.10752',
    0.7,
    "Running diffusion in a pretrained autoencoder's latent space cuts compute while keeping image quality, with cross-attention conditioning.",
  ],
  [
    'chain-of-thought',
    'Chain-of-Thought Prompting Elicits Reasoning in Large Language Models',
    '2201.11903',
    0.65,
    'Prompting with worked examples that show intermediate steps sharply improves large models on arithmetic and commonsense reasoning.',
  ],
  [
    'instructgpt',
    'Training language models to follow instructions with human feedback',
    '2203.02155',
    0.7,
    'Fine-tuning GPT-3 on demonstrations and then with RLHF yields a 1.3B model preferred to the 175B original.',
  ],
  [
    'chinchilla',
    'Training Compute-Optimal Large Language Models',
    '2203.15556',
    0.75,
    'For a fixed compute budget, parameters and training tokens should grow in equal proportion; current models are undertrained.',
  ],
  [
    'flash-attention',
    'FlashAttention: Fast and Memory-Efficient Exact Attention with IO-Awareness',
    '2205.14135',
    0.8,
    'A tiled attention kernel that avoids materialising the attention matrix in GPU memory, giving exact attention several times faster.',
  ],
  [
    'llama',
    'LLaMA: Open and Efficient Foundation Language Models',
    '2302.13971',
    0.45,
    'A family of 7B–65B models trained only on public data, the 13B model outperforming GPT-3 on most benchmarks.',
  ],
  [
    'dpo',
    'Direct Preference Optimization: Your Language Model is Secretly a Reward Model',
    '2305.18290',
    0.85,
    'The RLHF objective has a closed-form optimal policy, so preferences can be fit with a classification loss and no reward model.',
  ],
  [
    'simclr',
    'A Simple Framework for Contrastive Learning of Visual Representations',
    '2002.05709',
    0.75,
    'Strong augmentations, a projection head and large batches make plain contrastive learning match supervised ResNet-50.',
  ],
  [
    'moco',
    'Momentum Contrast for Unsupervised Visual Representation Learning',
    '1911.05722',
    0.7,
    'A queue of negatives encoded by a slowly-moving encoder makes a large, consistent dictionary for contrastive learning.',
  ],
  [
    'adversarial-examples',
    'Explaining and Harnessing Adversarial Examples',
    '1412.6572',
    0.6,
    'Adversarial examples come from linearity in high dimensions; the fast gradient sign method makes them cheaply, for training.',
  ],
  [
    'ntk',
    'Neural Tangent Kernel: Convergence and Generalization in Neural Networks',
    '1806.07572',
    0.8,
    'In the infinite-width limit, gradient descent on a network is kernel regression with a fixed kernel.',
  ],
  [
    'double-descent',
    'Deep Double Descent: Where Bigger Models and More Data Hurt',
    '1912.02292',
    0.55,
    'Test error first rises then falls again as model size, training time or data grows past the interpolation threshold.',
  ],
  [
    'nerf',
    'NeRF: Representing Scenes as Neural Radiance Fields for View Synthesis',
    '2003.08934',
    0.9,
    'An MLP mapping position and direction to colour and density, rendered by volume rendering, synthesises photorealistic novel views.',
  ],
  [
    'rag',
    'Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks',
    '2005.11401',
    0.6,
    'A seq2seq model conditioned on passages from a dense retriever, trained end to end, sets the state of the art on open-domain QA.',
  ],
  [
    'react',
    'ReAct: Synergizing Reasoning and Acting in Language Models',
    '2210.03629',
    0.55,
    'Interleaving reasoning traces with actions against a tool lets a language model plan, look things up and correct itself.',
  ],
];

/** A target for a paper of the given quality: Reject is 1 − quality; better papers lean towards Oral. */
function targetFor(quality: number): [number, number, number, number] {
  const oral = quality * (0.04 + 0.25 * quality);
  const spotlight = quality * (0.12 + 0.2 * quality);
  return [oral, spotlight, quality - oral - spotlight, 1 - quality];
}

/** The fifty distinct papers: the ten with full abstracts, then {@link MORE_PAPERS}. */
const DISTINCT_PAPERS: Paper[] = [
  ...ICLR_2027,
  ...MORE_PAPERS.map(([slug, title, arxiv, quality, summary]) => ({
    slug,
    title,
    arxiv,
    summary,
    target: targetFor(quality),
  })),
];

/** How many times each paper is listed, so the list runs to several pages (50 a page). */
const COPIES = 5;

/** Every paper in the venue: the originals, then copies numbered 2…{@link COPIES} in slug and title. */
const PAPERS: Paper[] = Array.from({ length: COPIES }, (_, c) =>
  DISTINCT_PAPERS.map((p) => (c === 0 ? p : { ...p, slug: `${p.slug}-${c + 1}`, title: `${p.title} ${c + 1}` })),
).flat();

/** Works every seed paper cites that are not listed here, so a bibliography has both kinds (#38). */
const CLASSICS: ReferenceInput[] = [
  {
    title: 'Learning representations by back-propagating errors',
    authors: ['David E. Rumelhart', 'Geoffrey E. Hinton', 'Ronald J. Williams'],
    year: 1986,
    venue: 'Nature',
    url: 'https://doi.org/10.1038/323533a0',
  },
  {
    title: 'Adam: A Method for Stochastic Optimization',
    authors: ['Diederik P. Kingma', 'Jimmy Ba'],
    year: 2015,
    venue: 'International Conference on Learning Representations',
    url: 'https://arxiv.org/abs/1412.6980',
  },
];

/**
 * A seed paper's bibliography: up to five earlier seed papers (by arXiv id,
 * chosen deterministically, always the originals' slugs) and the classics.
 * The first paper in arXiv order cites only the classics.
 */
function referencesOf(p: Paper, seed: number): ReferenceInput[] {
  const rand = rng(seed);
  const earlier = DISTINCT_PAPERS.filter((q) => q.arxiv < p.arxiv);
  const picked = earlier.filter(() => rand() < 5 / Math.max(5, earlier.length));
  return [
    ...CLASSICS,
    ...picked.map((q) => ({
      title: q.title,
      authors: q.authors ?? [],
      year: 2000 + Number(q.arxiv.slice(0, 2)),
      venue: `arXiv preprint arXiv:${q.arxiv}`,
      url: `https://arxiv.org/abs/${q.arxiv}`,
      citedSlug: q.slug,
    })),
  ];
}

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
  for (const [i, p] of PAPERS.entries()) {
    boards.push(...(await seedPaper(db, p, 'ICLR 2027', 110, 1000 + i)));
  }
  await simulateCrowd(db, boards, bots, rng(42));
  await seedComments(db, boards, bots, rng(99));

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
  console.log(`papers: ${PAPERS.length}, markets: ${boards.length}`);
}

async function seedPaper(db: Database, p: Paper, kind: string, closesInDays: number, seed: number): Promise<Board[]> {
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
      references: referencesOf(p, seed),
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
      contract: DECISION_CONTRACT,
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

/**
 * What a bot says for the outcome it holds most of, best first like DECISIONS.
 * Markdown and TeX, as comments are rendered.
 */
const REMARKS: string[][] = [
  [
    'This is the paper people will still cite in five years. Oral, easily.',
    'Reviewers will argue about the experiments and then give it an oral anyway. The idea is too clean.',
    'If this is not an oral the committee was not reading.',
  ],
  [
    'Strong paper, but orals go to whatever the AC championed. **Spotlight** is the safe bet.',
    'The ablations are thorough. Spotlight feels right; oral would need a clearer story.',
  ],
  [
    'Solid, but incremental over prior work. Poster.',
    'Accepted, sure — but the main table is within noise of the baseline. Poster at best.',
    'Expected improvement is about $\\Delta \\approx 0.3$ points over the baseline. That is a poster, not a spotlight.',
  ],
  [
    'The main claim does not survive the second appendix. I expect a reject.',
    'Reviewer 2 will ask for:\n\n1. a baseline that is not from 2019,\n2. error bars,\n3. any theory at all.\n\nNone of that fits in a rebuttal.',
    'Novelty is thin and the comparison is to an untuned baseline. Reject is underpriced.',
  ],
];

/** What a bot replies with: agreeing when it holds what the comment argues for, else not. */
const REPLIES = {
  agree: ['Agreed.', 'Same read here; I bought more after the reviews came out.', 'This. The appendix settles it.'],
  disagree: [
    'I doubt it. The reviews I have seen are lukewarm.',
    'You are pricing the hype, not the paper.',
    'Disagree — the baseline in Table 2 is mistuned, and reviewers will notice.',
    'Counterpoint: $p < 0.05$ on one seed is not a result.',
  ],
};

/** Decision markets that get a discussion. */
const DISCUSSED = 8;
/** Top-level comments on the first discussed market: more than a page (20), so "load more" shows. */
const BUSY_COMMENTS = 26;
/**
 * Under its first comment: more direct replies than a preview shows (3), and
 * a chain of replies to replies deeper than it shows (3 levels), so "more
 * replies" shows at both.
 */
const LONG_THREAD = { direct: 6, chain: 5 };

/**
 * A discussion on the first {@link DISCUSSED} decision markets, through
 * `server/comments.ts` and `server/backings.ts` as the API would: 2–5 bots
 * that hold shares there each say why, about the outcome they hold most of,
 * a few others reply, and other bots holding that outcome back some comments
 * with part of it. The first market is busy enough to page through.
 */
async function seedComments(db: Database, boards: Board[], bots: Bot[], rand: () => number) {
  // Shares each bot has put behind comments, by outcome id, so backings stay within positions.
  const allocated = new Map<string, number>();
  const held = (bot: Bot, outcomeId: string) =>
    (bot.held.get(outcomeId) ?? 0) - (allocated.get(`${bot.id}:${outcomeId}`) ?? 0);
  const favourite = (bot: Bot, board: Board) => {
    let best = -1;
    for (const [i, id] of board.outcomeIds.entries()) {
      if ((bot.held.get(id) ?? 0) > 0 && (best < 0 || bot.held.get(id)! > bot.held.get(board.outcomeIds[best])!)) {
        best = i;
      }
    }
    return best;
  };

  let count = 0;
  let backed = 0;
  const decisions = boards.filter((b) => b.outcomeIds.length === DECISIONS.length && b.decided === undefined);
  const pick = (lines: string[]) => lines[Math.floor(rand() * lines.length)];
  for (const [n, board] of decisions.slice(0, DISCUSSED).entries()) {
    const holders = shuffle(
      bots.filter((bot) => favourite(bot, board) >= 0),
      rand,
    );
    const speakers =
      n === 0
        ? Array.from({ length: BUSY_COMMENTS }, (_, k) => holders[k % holders.length])
        : holders.slice(0, 2 + Math.floor(rand() * 4));
    for (const [k, author] of speakers.entries()) {
      const i = favourite(author, board);
      const { id } = await postComment({ marketId: board.marketId, accountId: author.id, body: pick(REMARKS[i]) }, db);
      count++;
      const outcomeId = board.outcomeIds[i];

      // Each reply answers the comment or an earlier reply under it; the long thread's are planned.
      const others = shuffle(
        holders.filter((b) => b !== author),
        rand,
      );
      const long = n === 0 && k === 0;
      const replies = long ? LONG_THREAD.direct + LONG_THREAD.chain : Math.floor(rand() * 4);
      const thread = [{ id, outcome: i }];
      for (let r = 0; r < replies; r++) {
        const parent = long
          ? r < LONG_THREAD.direct
            ? thread[0]
            : thread[r === LONG_THREAD.direct ? 1 : r]
          : thread[Math.floor(rand() * thread.length)];
        const replier = others[r % others.length];
        const lines = favourite(replier, board) === parent.outcome ? REPLIES.agree : REPLIES.disagree;
        const reply = await postComment(
          { marketId: board.marketId, accountId: replier.id, parentId: parent.id, body: pick(lines) },
          db,
        );
        thread.push({ id: reply.id, outcome: favourite(replier, board) });
        count++;
      }

      for (const backer of bots) {
        if (backer === author || rand() < 0.4) continue;
        const shares = Math.floor(held(backer, outcomeId) * (0.2 + 0.5 * rand()));
        if (shares < 1_000_000) continue;
        await backComment({ commentId: id, accountId: backer.id, outcomeId, sharesMicro: BigInt(shares) }, db);
        const key = `${backer.id}:${outcomeId}`;
        allocated.set(key, (allocated.get(key) ?? 0) + shares);
        backed++;
      }
    }
  }
  console.log(`comments: ${count}, backings: ${backed}`);
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
 * to say), and its comments, in order, over the second half of that. Only
 * timestamps change; shares, costs, positions and the ledger are exactly what
 * the engine wrote. Never do this outside a seed.
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
    await db
      .update(orders)
      .set({ createdAt: new Date(times[i]) })
      .where(eq(orders.id, f.id));
  }
  const said = await db
    .select({ id: comments.id })
    .from(comments)
    .where(eq(comments.marketId, marketId))
    .orderBy(asc(comments.createdAt), asc(comments.id));
  for (const [i, c] of said.entries()) {
    const at = start + (0.5 + (0.5 * (i + rand())) / said.length) * (end - start);
    await db
      .update(comments)
      .set({ createdAt: new Date(at) })
      .where(eq(comments.id, c.id));
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
