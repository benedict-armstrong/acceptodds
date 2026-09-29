import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  bigserial,
  check,
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
} from 'drizzle-orm/pg-core';
import { user } from './auth-schema';

/**
 * Every monetary column below is a `BIGINT` of micro-units read as a
 * `bigint` (invariant §1.6). There is no `numeric` and no `double precision`
 * holding money anywhere in this file. The two `double precision` columns are
 * `markets.b` (a cost-function parameter, not money) and the price snapshots
 * on `orders` (probabilities).
 */
const money = (name: string) => bigint(name, { mode: 'bigint' });

const createdAt = () =>
  timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow();

export const marketStatus = pgEnum('market_status', [
  'draft',
  'open',
  'closed',
  'settled',
  'void',
]);

export const ledgerReason = pgEnum('ledger_reason', [
  'signup',
  'trade',
  'settlement',
  'subsidy',
  'adjustment',
]);

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
    institutionName: text('institution_name'),
    verifiedAt: timestamp('verified_at', { withTimezone: true, mode: 'date' }),
    /** Cache of `sum(ledger_entries.delta_micro)`. Written in the same transaction, always. */
    balanceMicro: money('balance_micro').notNull().default(sql`0`),
    isBot: boolean('is_bot').notNull().default(false),
    isHouse: boolean('is_house').notNull().default(false),
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
    authors: text('authors').array().notNull().default(sql`'{}'::text[]`),
    /** `[{ label, url }]`, http(s) only (checked at the API). Display data, nothing more. */
    links: jsonb('links').$type<ListingLink[]>().notNull().default(sql`'[]'::jsonb`),
    /** Opaque to the platform, like `markets.kind`. */
    kind: text('kind'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('listings_slug_key').on(t.slug)],
);

export interface ListingLink {
  label: string;
  url: string;
}

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
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('markets_slug_key').on(t.slug),
    index('markets_status_idx').on(t.status),
    index('markets_listing_id_idx').on(t.listingId),
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
    sharesMicro: money('shares_micro').notNull().default(sql`0`),
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
    sharesMicro: money('shares_micro').notNull().default(sql`0`),
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
  (t) => [
    index('ledger_entries_account_id_idx').on(t.accountId),
    index('ledger_entries_order_id_idx').on(t.orderId),
  ],
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
  (t) => [
    index('events_created_at_idx').on(t.createdAt),
    index('events_kind_created_idx').on(t.kind, t.createdAt),
  ],
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
    incurredAt: timestamp('incurred_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
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
    body: text('body').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (t) => [index('comments_market_created_idx').on(t.marketId, t.createdAt)],
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

export type Account = typeof accounts.$inferSelect;
export type Listing = typeof listings.$inferSelect;
export type Market = typeof markets.$inferSelect;
export type Outcome = typeof outcomes.$inferSelect;
export type Order = typeof orders.$inferSelect;
export type Position = typeof positions.$inferSelect;
export type CommentBacking = typeof commentBackings.$inferSelect;
/** What an API credential may do. Stored as the API-key plugin's permissions, `{ api: [...] }`. */
export const TOKEN_SCOPES = ['read', 'trade', 'admin'] as const;
export type TokenScope = (typeof TOKEN_SCOPES)[number];
