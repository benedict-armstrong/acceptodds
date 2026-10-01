import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  bigserial,
  check,
  date,
  doublePrecision,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  jsonb,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { user } from './auth-schema';

/**
 * Every monetary column below is a `BIGINT` of micro-units read as a
 * `bigint` (invariant §1.6). There is no `numeric` and no `double precision`
 * holding money anywhere in this file. The `double precision` columns are
 * `markets.b` (a cost-function parameter, not money) and the prices on
 * `orders` and `markets.headline` (probabilities).
 */
const money = (name: string) => bigint(name, { mode: 'bigint' });

const createdAt = () => timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow();

export const marketStatus = pgEnum('market_status', ['draft', 'open', 'closed', 'settled', 'void']);

export const ledgerReason = pgEnum('ledger_reason', ['signup', 'trade', 'settlement', 'subsidy', 'adjustment']);

/**
 * Traders. Ours, not Better Auth's.
 *
 * `user_id` references Better Auth's `user` table (`db/auth-schema.ts`, which
 * its CLI generates). One trader per user, created with the signup grant when
 * the user is. Bots have a `user` row too — login-less, so that the API-key
 * plugin, which keys on users, can issue their tokens — and carry `is_bot`.
 * House rows (treasury and makers) have none. `on delete set null`: deleting
 * an identity must never delete a ledger.
 *
 * Three kinds of row live here:
 *   - humans and bots, the traders;
 *   - the house treasury, `is_house` and handle `house`;
 *   - one market maker per market, also `is_house`, holding that market's
 *     subsidy and its trade takings. See `markets.maker_account_id`.
 */
export const accounts = pgTable(
  'accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id').references(() => user.id, { onDelete: 'set null' }),
    handle: text('handle').notNull(),
    displayName: text('display_name').notNull(),
    orcid: text('orcid'),
    rorId: text('ror_id'),
    /**
     * Cache of the institutions of this account's **confirmed** `affiliations`,
     * the sign-up address's first, then by confirmation time; distinct. Written
     * in the same transaction as the affiliation, always (`server/affiliations.ts`).
     */
    institutions: text('institutions')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** When the account's first institutional address was confirmed; `null` once none is. Gates trading. */
    verifiedAt: timestamp('verified_at', { withTimezone: true, mode: 'date' }),
    /** Cache of `sum(ledger_entries.delta_micro)`. Written in the same transaction, always. */
    balanceMicro: money('balance_micro')
      .notNull()
      .default(sql`0`),
    isBot: boolean('is_bot').notNull().default(false),
    isHouse: boolean('is_house').notNull().default(false),
    /** Whether the daily digest of followed papers may be mailed (`server/digest.ts`). On by default. */
    digestOptIn: boolean('digest_opt_in').notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('accounts_handle_key').on(t.handle),
    uniqueIndex('accounts_user_id_key')
      .on(t.userId)
      .where(sql`user_id is not null`),
    uniqueIndex('accounts_orcid_key')
      .on(t.orcid)
      .where(sql`orcid is not null`),
  ],
);

/**
 * A listing: an **opaque subject** that one or more markets are about.
 *
 * Supplied whole by the creating client (`../research`) and never fetched,
 * checked or interpreted here: a title, a free-text summary, a list of names,
 * a list of labelled links and an opaque `kind`. The venue does not know what
 * a listing is — only the UI calls it a "paper". No money lives here.
 *
 * A market belongs to at most one listing (`markets.listing_id`); the market
 * with the lowest `listing_rank` (0) is the listing's main market.
 */
export const listings = pgTable(
  'listings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull(),
    title: text('title').notNull(),
    summary: text('summary'),
    authors: text('authors')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** `[{ label, url }]`, http(s) only (checked at the API). Display data, nothing more. */
    links: jsonb('links')
      .$type<ListingLink[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** Opaque to the platform, like `markets.kind`. */
    kind: text('kind'),
    /** Cache of the unique viewers per day, summed (`listing_views`). Written only by `server/view-counter.ts`. */
    viewCount: integer('view_count').notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('listings_slug_key').on(t.slug),
    // Full-text search (`views.ts`). `search_vector` is a stored generated
    // column, `listing_search_vector(title, authors, summary)`, added by
    // drizzle/0006 and deliberately left out of this schema, so that no row
    // read through Drizzle carries it. It is stored rather than an expression
    // index because ranking — and the recheck of a lossy GIN match — would
    // otherwise rebuild the vector for every matching row: 5 s for a query
    // matching all of 30k papers, against 0.1 s stored.
    index('listings_search_idx').using('gin', sql`search_vector`),
    index('listings_created_idx').on(t.createdAt, t.id),
  ],
);

export interface ListingLink {
  label: string;
  url: string;
}

/**
 * A listing's bibliography (#38): what the paper cites, in its own order,
 * supplied whole by `../research` with the listing (`POST /listings`
 * replaces the list) and written only by `server/listings.ts`, in the
 * upsert's transaction. The venue extracts nothing and checks nothing.
 *
 * `cited_slug` says the cited work is (or may one day be) a listing here. It
 * is matched against `listings.slug` when read, never by a foreign key, so a
 * reference to a paper listed later links up by itself, and "cited by" is the
 * reverse lookup on its index.
 */
export const listingReferences = pgTable(
  'listing_references',
  {
    listingId: uuid('listing_id')
      .notNull()
      .references(() => listings.id, { onDelete: 'cascade' }),
    /** 0-based order in the bibliography. */
    position: integer('position').notNull(),
    title: text('title').notNull(),
    authors: text('authors')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    year: integer('year'),
    /** Where it appeared, as the bibliography sets it ("International Conference on Learning Representations"). Opaque. */
    venue: text('venue'),
    /** http(s) only (checked at the API). */
    url: text('url'),
    citedSlug: text('cited_slug'),
  },
  (t) => [
    primaryKey({ columns: [t.listingId, t.position] }),
    index('listing_references_cited_idx')
      .on(t.citedSlug)
      .where(sql`${t.citedSlug} is not null`),
  ],
);

/**
 * A market is a question, a set of outcomes, an id and a resolution rule.
 *
 * It is not a paper. There is no arXiv id, no venue client and no corpus
 * anywhere in this package — `kind` and `resolution_source` are opaque strings
 * that `../research` fills in and this side never interprets.
 */
export const markets = pgTable(
  'markets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull(),
    question: text('question').notNull(),
    description: text('description'),
    /**
     * The market's contract: how it resolves, in detail (edge cases included).
     * Opaque text supplied by the creating client, shown to traders as
     * Markdown and never interpreted here. `description` is for anything else.
     */
    contract: text('contract'),
    /** Opaque to the platform. Whatever the creating client wants to group by. */
    kind: text('kind').notNull().default('binary'),
    status: marketStatus('status').notNull().default('draft'),
    /**
     * The LMSR liquidity parameter, in micro-units, **frozen at creation**
     * (invariant §1.3).
     *
     * Computed once by `lmsr.liquidityFor` in `engine.createMarket` and never
     * touched again. Recomputing it mid-market changes the cost function under
     * existing positions and lets a trader extract reputation from the
     * transition. There is deliberately no code path that writes this column
     * after the insert.
     */
    b: doublePrecision('b').notNull(),
    /** This market's maker: the account holding its subsidy and its takings (§1.7). */
    makerAccountId: uuid('maker_account_id')
      .notNull()
      .references(() => accounts.id),
    opensAt: timestamp('opens_at', { withTimezone: true, mode: 'date' }),
    closesAt: timestamp('closes_at', { withTimezone: true, mode: 'date' }).notNull(),
    resolutionSource: text('resolution_source'),
    /** No FK: `outcomes` references `markets`, and a cycle is not worth the migration ordering. */
    resolvedOutcomeId: uuid('resolved_outcome_id'),
    resolutionEvidenceUrl: text('resolution_evidence_url'),
    settledAt: timestamp('settled_at', { withTimezone: true, mode: 'date' }),
    createdBy: uuid('created_by').references(() => accounts.id),
    /** The opaque subject this market is about, if any. Display grouping only. */
    listingId: uuid('listing_id').references(() => listings.id),
    /** Order within its listing; 0, the lowest, is the listing's main market. */
    listingRank: integer('listing_rank').notNull().default(0),
    /**
     * Whether this market stands for its row in browse lists: a visible market
     * with no listing, or its listing's **main market** — the visible market
     * with the lowest `listing_rank`, ties by age. Never true for a draft.
     *
     * Written only by `engine.createMarket`, under a per-listing advisory lock.
     * It cannot change later: a draft never becomes visible, and nothing moves
     * a market's rank. At most one per listing (`markets_main_per_listing_key`).
     */
    isMain: boolean('is_main').notNull().default(false),
    /**
     * Caches of the fills, for sorting browse lists without reading `orders`:
     * Σ |cost_micro|, the fill count and the latest fill's `created_at`.
     * Written by `engine.trade` in the fill's own transaction, under the
     * market row lock it already holds — like `accounts.balance_micro`.
     */
    volumeMicro: money('volume_micro')
      .notNull()
      .default(sql`0`),
    orderCount: integer('order_count').notNull().default(0),
    lastTradeAt: timestamp('last_trade_at', { withTimezone: true, mode: 'date' }),
    /**
     * `marketHeadline` (`lib/headline.ts`), for sorting only: the headline
     * price of the share vector, set at creation and after every fill; 1 or 0
     * by the result once settled. A probability, not money. Readers treat a
     * void market as having none, whatever this last held.
     */
    headline: doublePrecision('headline'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('markets_slug_key').on(t.slug),
    index('markets_status_idx').on(t.status),
    index('markets_listing_id_idx').on(t.listingId),
    index('markets_created_idx').on(t.createdAt, t.id),
    // Browse rows (`views.browseListings`): the main markets of a venue.
    index('markets_main_idx')
      .on(t.kind, t.status)
      .where(sql`is_main`),
    uniqueIndex('markets_main_per_listing_key')
      .on(t.listingId)
      .where(sql`is_main`),
    // The other visible markets of a listing, summed into its row.
    index('markets_secondary_idx')
      .on(t.listingId)
      .where(sql`not is_main and status <> 'draft'`),
    // Full-text search; see `listings_search_idx`. `search_vector` here is
    // `market_search_vector(question, description)`, likewise stored.
    index('markets_search_idx').using('gin', sql`search_vector`),
  ],
);

/** The share vector. `shares_micro` is the `q_i` the cost function is a function of. */
export const outcomes = pgTable(
  'outcomes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    marketId: uuid('market_id')
      .notNull()
      .references(() => markets.id, { onDelete: 'cascade' }),
    label: text('label').notNull(),
    /** Position in the share vector. Stable; the cost function is indexed by it. */
    ordinal: integer('ordinal').notNull(),
    sharesMicro: money('shares_micro')
      .notNull()
      .default(sql`0`),
    /**
     * What `shares_micro` was when the market opened: all zeros for a uniform
     * market, `lmsr.openingShares(prior, b)` for one opened at a prior. The
     * share vector is this plus the sum of the order shares, so every replay
     * from the fills starts here. Written once, by `createMarket`.
     */
    openingSharesMicro: money('opening_shares_micro')
      .notNull()
      .default(sql`0`),
  },
  (t) => [
    uniqueIndex('outcomes_market_ordinal_key').on(t.marketId, t.ordinal),
    index('outcomes_market_id_idx').on(t.marketId),
  ],
);

/**
 * Fills. One row per accepted trade.
 *
 * `shares_micro` and `cost_micro` are both **signed**: a sell is a trade with
 * negative shares and negative cost. There is no separate sell path.
 */
export const orders = pgTable(
  'orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id),
    marketId: uuid('market_id')
      .notNull()
      .references(() => markets.id, { onDelete: 'cascade' }),
    outcomeId: uuid('outcome_id')
      .notNull()
      .references(() => outcomes.id, { onDelete: 'cascade' }),
    sharesMicro: money('shares_micro').notNull(),
    costMicro: money('cost_micro').notNull(),
    priceBefore: doublePrecision('price_before').notNull(),
    priceAfter: doublePrecision('price_after').notNull(),
    idempotencyKey: text('idempotency_key'),
    /**
     * `clock_timestamp()`, not `now()`.
     *
     * `now()` is the transaction *start* time, and a trade that queued on the
     * market row lock started before the trade that beat it to the lock. That
     * would put the price tape in an order the prices were never in. This is
     * the time the row was actually written, under the lock, so the tape is
     * monotonic.
     */
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (t) => [
    // Price history is read as (market, time).
    index('orders_market_created_idx').on(t.marketId, t.createdAt),
    index('orders_account_id_idx').on(t.accountId),
    // Bots retry. This is what makes the retry return the original fill
    // rather than trading twice.
    uniqueIndex('orders_account_idempotency_key')
      .on(t.accountId, t.idempotencyKey)
      .where(sql`idempotency_key is not null`),
  ],
);

/** Holdings. Signed in the column, but `engine.trade` never lets one go below zero. */
export const positions = pgTable(
  'positions',
  {
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    outcomeId: uuid('outcome_id')
      .notNull()
      .references(() => outcomes.id, { onDelete: 'cascade' }),
    sharesMicro: money('shares_micro')
      .notNull()
      .default(sql`0`),
  },
  (t) => [
    primaryKey({ columns: [t.accountId, t.outcomeId] }),
    index('positions_account_id_idx').on(t.accountId),
    index('positions_outcome_id_idx').on(t.outcomeId),
  ],
);

/**
 * The reputation ledger. This is a source of truth; `accounts.balance_micro`
 * is a cache of its sum, written in the same transaction.
 *
 * Every movement is written as a balanced pair of rows — the trader and the
 * market maker, or the house and the market maker — so the sum of all
 * `delta_micro` over the whole table is exactly the reputation granted at
 * signup, and stays that way through every trade and every settlement.
 */
export const ledgerEntries = pgTable(
  'ledger_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id),
    deltaMicro: money('delta_micro').notNull(),
    reason: ledgerReason('reason').notNull(),
    orderId: uuid('order_id').references(() => orders.id, { onDelete: 'set null' }),
    marketId: uuid('market_id').references(() => markets.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [index('ledger_entries_account_id_idx').on(t.accountId), index('ledger_entries_order_id_idx').on(t.orderId)],
);

/**
 * The global log, and **never a source of truth** (invariant §1.4).
 *
 * Effects live in `orders`, `positions` and `ledger_entries`. This table holds
 * only what would otherwise leave no trace — above all reads: who looked at
 * which board, and when.
 *
 * **There is no payload column. Do not add one.** A payload turns the log into
 * a shadow copy of the tables above, which then disagrees with them. And a
 * write here must never raise into the caller: see `server/events.ts`.
 *
 * **No foreign keys, deliberately.** An FK on `market_id` makes every log
 * insert take a `FOR KEY SHARE` lock on the very market row the trade
 * transaction is holding `FOR UPDATE` — which turns the log into a
 * participant in the engine's locking and, as this actually did, into a
 * deadlock. The log is not a source of truth; it does not get to block one.
 * A dangling id here means the row was deleted, and that is fine.
 */
export const events = pgTable(
  'events',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    kind: text('kind').notNull(),
    accountId: uuid('account_id'),
    marketId: uuid('market_id'),
    createdAt: createdAt(),
  },
  (t) => [index('events_created_at_idx').on(t.createdAt), index('events_kind_created_idx').on(t.kind, t.createdAt)],
);

/**
 * Real money. Model spend, API bills.
 *
 * Invariant §1.5: two ledgers, and only one of them is play money. There is
 * deliberately **no foreign key** from this table to anything above it, and
 * there must be no query anywhere that sums across the two. Reputation is a
 * game currency; this is dollars.
 *
 * Stored as micro-USD, for the same reason reputation is: money is an integer.
 */
export const usdCosts = pgTable(
  'usd_costs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    source: text('source').notNull(),
    amountUsdMicro: money('amount_usd_micro').notNull(),
    incurredAt: timestamp('incurred_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [index('usd_costs_incurred_at_idx').on(t.incurredAt)],
);

/**
 * Per-credential token buckets for the API rate limit (IMPLEMENTATION.md §7).
 *
 * One row per bucket, updated in the request it limits. `key` is opaque
 * (`apikey:<id>` for an API key, `user:<id>` for a session) and carries no foreign
 * key, for the same reason `events` doesn't: this table is bookkeeping, and it
 * must never take a lock on a row anything else is holding.
 *
 * `tokens` is a fractional count of requests, not money, so it is a double.
 */
export const rateLimitBuckets = pgTable('rate_limit_buckets', {
  key: text('key').primaryKey(),
  tokens: doublePrecision('tokens').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull(),
});

/**
 * Market discussion (M6). Not market state and not a source of truth for
 * anything: a comment is text attached to a market by an account.
 *
 * **Shown anonymously.** Readers see a comment's text, its time, whether the
 * author is a bot, and the author's *current* stake in that market — never a
 * handle or an account id (see `server/comments.ts`). `account_id` is here so
 * the stake can be computed and so moderation is possible, not for display.
 *
 * **Threads are one level deep.** `parent_id` is null on a top-level comment
 * and names a top-level comment on a reply, on the same market; a reply to a
 * reply joins its thread (`server/comments.ts`). Top-level comments page on
 * their own; each thread's replies page separately, oldest first.
 */
export const comments = pgTable(
  'comments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    marketId: uuid('market_id')
      .notNull()
      .references(() => markets.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    parentId: uuid('parent_id').references((): AnyPgColumn => comments.id, { onDelete: 'cascade' }),
    body: text('body').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (t) => [
    index('comments_market_created_idx').on(t.marketId, t.createdAt),
    index('comments_parent_created_idx').on(t.parentId, t.createdAt, t.id),
  ],
);

/**
 * Stake put behind a comment: "I hold these shares, and I think this comment
 * is right". Shares of one outcome of the comment's market, held by the
 * backer, never the comment's author.
 *
 * **Not market state, and not money.** No reputation moves when a backing is
 * made or removed; the shares stay in `positions`, where they are. A backing
 * is a claim on part of a position, so it is bound to it:
 *
 *   - for each (account, outcome), Σ `shares_micro` ≤ the position. Enforced
 *     when a backing is made (`server/backings.ts`, under the account's row
 *     lock) and when a position shrinks: `engine.trade()` trims backings on a
 *     sell, **newest first** (LIFO), in the trade's own transaction;
 *   - settlement zeroes positions but keeps backings, as a frozen record,
 *     valued at 1 per share of the winner and 0 otherwise.
 *
 * Foreign keys, unlike `events`, and safe: only `server/backings.ts`
 * inserts, and an insert's FK checks take `FOR KEY SHARE` on the comment, the
 * account (which that transaction already holds `FOR UPDATE`) and the outcome
 * (which a trade only ever updates without touching its key, so the two
 * never conflict). Nothing here locks the market row a trade holds. The
 * engine only updates and deletes rows here, which takes no parent locks.
 */
export const commentBackings = pgTable(
  'comment_backings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    commentId: uuid('comment_id')
      .notNull()
      .references(() => comments.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    outcomeId: uuid('outcome_id')
      .notNull()
      .references(() => outcomes.id, { onDelete: 'cascade' }),
    sharesMicro: money('shares_micro').notNull(),
    // clock_timestamp(), not now(): LIFO order must be the order backings were
    // actually made in, not their transactions' start times.
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (t) => [
    check('comment_backings_shares_positive', sql`${t.sharesMicro} > 0`),
    index('comment_backings_account_outcome_created_idx').on(t.accountId, t.outcomeId, t.createdAt),
    index('comment_backings_comment_idx').on(t.commentId),
  ],
);

/**
 * An institutional email address an account is affiliated through
 * (`server/affiliations.ts`). The sign-up address is one, `is_primary`, made
 * confirmed when the account is created. Others are added from `/profile` and
 * confirmed by a 6-digit code mailed to them: until then `verified_at` is
 * null and the row counts for nothing. Only an address on the institution
 * allowlist can be one; `institution_name` is its entry's name at the time.
 *
 * A confirmed address belongs to one account at most (the partial unique
 * index). `accounts.institutions` and `accounts.verified_at` cache what the
 * confirmed rows say, written in the same transaction.
 */
export const affiliations = pgTable(
  'affiliations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    /** Lower-cased. */
    email: text('email').notNull(),
    institutionName: text('institution_name').notNull(),
    isPrimary: boolean('is_primary').notNull().default(false),
    /** SHA-256 of the outstanding code, hex; null once confirmed. */
    codeHash: text('code_hash'),
    codeExpiresAt: timestamp('code_expires_at', { withTimezone: true, mode: 'date' }),
    /** Wrong codes against the outstanding one; a new code resets it. */
    codeAttempts: integer('code_attempts').notNull().default(0),
    verifiedAt: timestamp('verified_at', { withTimezone: true, mode: 'date' }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('affiliations_account_email_key').on(t.accountId, t.email),
    uniqueIndex('affiliations_verified_email_key')
      .on(t.email)
      .where(sql`verified_at is not null`),
    uniqueIndex('affiliations_primary_key')
      .on(t.accountId)
      .where(sql`is_primary`),
  ],
);

/**
 * Who follows (stars) which listing. Listings only: a market with no listing
 * cannot be followed. A preference, not market state and not money: written
 * by `server/follows.ts` in its own statement, never by the engine.
 */
export const listingFollows = pgTable(
  'listing_follows',
  {
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    listingId: uuid('listing_id')
      .notNull()
      .references(() => listings.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.accountId, t.listingId] }), index('listing_follows_listing_idx').on(t.listingId)],
);

/**
 * Who looked at a listing today, so that a visitor counts once a day
 * (`server/view-counter.ts`). `visitor` is an HMAC of the UTC day, the client
 * IP and user agent under a server secret: it cannot be reversed to an
 * address, and, the day being inside it, cannot link one day's visitor to the
 * next. Only today's and yesterday's rows are kept; `listings.view_count`
 * is what lasts. A cache of reads, not a source of truth, so like `events` it
 * has no foreign keys and can never take a lock on a row anything else holds.
 */
export const listingViews = pgTable(
  'listing_views',
  {
    listingId: uuid('listing_id').notNull(),
    day: date('day', { mode: 'string' }).notNull(),
    visitor: text('visitor').notNull(),
  },
  (t) => [primaryKey({ columns: [t.listingId, t.day, t.visitor] }), index('listing_views_day_idx').on(t.day)],
);

/**
 * A position its holder has made public (#36): shared by a link,
 * `/positions/<id>`, and listed on their `/people/<handle>` page. Opt-in,
 * one (account, outcome) at a time. It names the holder, so it links them to
 * their comments on that market, whose stake is otherwise their only mark:
 * the UI says so before it is made.
 *
 * **A pointer, not a copy**: what is shown is read live from `orders`, so the
 * link keeps following the position as it is sold or settled. Only
 * `shared_shares_micro` is kept, what was held when it was made public, so a
 * later reader can see it was sold since. Not money and not market state:
 * written by `server/public-positions.ts` in single statements, never by the
 * engine. Deleting the row makes it private again; its link then 404s.
 */
export const publicPositions = pgTable(
  'public_positions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    outcomeId: uuid('outcome_id')
      .notNull()
      .references(() => outcomes.id, { onDelete: 'cascade' }),
    sharedSharesMicro: money('shared_shares_micro').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('public_positions_account_outcome_key').on(t.accountId, t.outcomeId),
    check('public_positions_shares_positive', sql`${t.sharedSharesMicro} > 0`),
  ],
);

/**
 * Leaderboard groups (#25): a named set of traders, ranked among themselves.
 * Made by a trader, who is its admin and one of its members; joined by
 * `invite_code`, which the admin can rotate. An institution is a group too,
 * but a derived one (`accounts.institutions`), never a row here. Written
 * only by `server/groups.ts`, never by the engine: no money lives on a group.
 */
export const groups = pgTable(
  'groups',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    description: text('description'),
    adminAccountId: uuid('admin_account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    inviteCode: text('invite_code').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('groups_invite_code_key').on(t.inviteCode),
    index('groups_admin_idx').on(t.adminAccountId),
    check('groups_name_length', sql`char_length(${t.name}) between 1 and 80`),
    check('groups_description_length', sql`char_length(${t.description}) <= 500`),
  ],
);

export const groupMembers = pgTable(
  'group_members',
  {
    groupId: uuid('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    joinedAt: timestamp('joined_at', { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (t) => [primaryKey({ columns: [t.groupId, t.accountId] }), index('group_members_account_idx').on(t.accountId)],
);

export type Group = typeof groups.$inferSelect;

/**
 * One row per digest mail, keyed by the account and the digest's calendar
 * day (in `DIGEST_TIMEZONE`). Inserted **before** the mail is sent, so a
 * second run on the same day sends nothing: at most once (`server/digest.ts`).
 */
export const digestSends = pgTable(
  'digest_sends',
  {
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    day: date('day', { mode: 'string' }).notNull(),
    sentAt: timestamp('sent_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.accountId, t.day] })],
);

/**
 * A bet chosen during onboarding (`/welcome`) by someone who has no account
 * yet: one per Better Auth user, written by `server/onboarding.ts` when the
 * sign-up mail goes out. **Not an order and not money**: nothing is reserved,
 * no price is held. After confirming, the person places it themselves, through
 * the API like any order, at the price then — the stake is what is kept, not
 * the share count — and the row is deleted.
 */
export const pendingBets = pgTable(
  'pending_bets',
  {
    userId: text('user_id')
      .primaryKey()
      .references(() => user.id, { onDelete: 'cascade' }),
    marketId: uuid('market_id')
      .notNull()
      .references(() => markets.id, { onDelete: 'cascade' }),
    outcomeId: uuid('outcome_id')
      .notNull()
      .references(() => outcomes.id, { onDelete: 'cascade' }),
    stakeMicro: money('stake_micro').notNull(),
    /**
     * The market's `order_count` on the board the bet was chosen from. Prices
     * move only by fills, so while it is unchanged the bet is placed at the
     * price the person saw, without asking again. Null on bets stored before
     * it was recorded: treated as moved.
     */
    seenOrderCount: integer('seen_order_count'),
    /**
     * SHA-256 of the nonce in the `onboarding_browser` cookie of the browser
     * the bet was chosen in (`server/onboarding.ts`). Only there is it placed
     * without asking; anyone may replace an unconfirmed address's bet, so
     * anywhere else it is shown first. Null: never placed without asking.
     */
    browserHash: text('browser_hash'),
    createdAt: createdAt(),
  },
  (t) => [check('pending_bets_stake_positive', sql`${t.stakeMicro} > 0`)],
);

/**
 * A snapshot of the whole field's net worth at liquidation value, for the
 * "where you stand" curves (navbar, portfolio): the same for every viewer,
 * so computed once and shared, recomputed at most every few minutes by
 * `server/field-snapshot.ts`. Deliberately a little stale; the leaderboard
 * itself never reads it. One row per basis; only `net_worth` exists.
 *
 * `worths_micro` is every non-house trader's net worth, sorted ascending:
 * money, so `BIGINT`. `curve` is its kernel density at evenly spaced points
 * from `domain_lo` to `domain_hi` (units), scaled to peak at 1 — plotting
 * numbers, not money, hence `double precision`. No foreign keys: it is a
 * cache and never a source of truth, like `events`.
 */
export const fieldSnapshots = pgTable('field_snapshots', {
  basis: text('basis').primaryKey(),
  computedAt: timestamp('computed_at', { withTimezone: true, mode: 'date' }).notNull(),
  worthsMicro: money('worths_micro').array().notNull(),
  curve: doublePrecision('curve').array().notNull(),
  domainLo: doublePrecision('domain_lo').notNull(),
  domainHi: doublePrecision('domain_hi').notNull(),
});

export type Account = typeof accounts.$inferSelect;
export type Listing = typeof listings.$inferSelect;
export type ListingReference = typeof listingReferences.$inferSelect;
export type Market = typeof markets.$inferSelect;
export type Outcome = typeof outcomes.$inferSelect;
export type Order = typeof orders.$inferSelect;
export type Position = typeof positions.$inferSelect;
export type CommentBacking = typeof commentBackings.$inferSelect;
export type Affiliation = typeof affiliations.$inferSelect;
export type PendingBet = typeof pendingBets.$inferSelect;
export type PublicPosition = typeof publicPositions.$inferSelect;
/** What an API credential may do. Stored as the API-key plugin's permissions, `{ api: [...] }`. */
export const TOKEN_SCOPES = ['read', 'trade', 'admin'] as const;
export type TokenScope = (typeof TOKEN_SCOPES)[number];
