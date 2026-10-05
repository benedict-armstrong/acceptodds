import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { getDb } from '@/db';
import { isUniqueViolation } from '@/db/errors';
import * as schema from '@/db/schema';
import { accounts, commentBackings, ledgerEntries, markets, orders, outcomes, positions } from '@/db/schema';
import { lifoTrim } from '@/lib/backing';
import { cost, costToTrade, liquidityFor, openingShares, prices } from '@/lib/lmsr';
import { headlinePrice } from '@/lib/headline';
import { costToMicro, microToFloat } from '@/lib/money';
import { EngineError } from './errors';
import * as events from './events';
import { invalidateStandings } from './standings-cache';
import { invalidateMarketReads } from './market-cache';

/**
 * The engine. **The only module that writes market state.**
 *
 * Everything else in the app reads. If you are about to write to `outcomes`,
 * `orders`, `positions` or `ledger_entries` from somewhere else, don't: put it
 * here, where the transaction and the invariants live together. (It also
 * trims `comment_backings` on a sell: not market state, but bound to the
 * position the sell shrinks. See `trade()`.)
 *
 * ## How the money moves, and why it is conserved (invariant §1.7)
 *
 * LMSR subsidises a market by at most `b · ln(n)`, and that reputation has to
 * come from somewhere. So every market gets its own **maker account** — a row
 * in `accounts` with `is_house`, pointed at by `markets.maker_account_id`:
 *
 *   - at creation the house treasury is debited `b · ln(n)` and the maker is
 *     credited exactly that. The maker's balance is now `C(0)`;
 *   - every trade moves `cost` between the trader and the maker, so the
 *     maker's balance is always `C(q)`, the cost function's current value;
 *   - at settlement the maker pays 1 unit per winning share, which is
 *     `q_winner ≤ C(q)`, and its residual is swept back to the treasury.
 *
 * Every movement is therefore a **balanced pair** of ledger rows. The sum of
 * all balances is exactly the reputation granted at signup and never moves,
 * and the maker can never go negative — which is `b · ln(n)` holding in the
 * integers rather than merely in the reals.
 */

type Db = NodePgDatabase<typeof schema>;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Executor = Db | Tx;

/** Handle of the single house treasury account. */
export const HOUSE_HANDLE = 'house';

export interface Quote {
  marketId: string;
  outcomeId: string;
  outcomeLabel: string;
  /** Signed: negative is a sell. */
  sharesMicro: bigint;
  /**
   * Priced for the **whole** requested size, slippage included — not
   * `shares × price`. Positive is what the trader pays; negative is what they
   * receive.
   */
  costMicro: bigint;
  priceBefore: number;
  priceAfter: number;
}

export interface Fill {
  orderId: string;
  accountId: string;
  marketId: string;
  outcomeId: string;
  sharesMicro: bigint;
  costMicro: bigint;
  priceBefore: number;
  priceAfter: number;
  balanceAfterMicro: bigint;
  positionAfterMicro: bigint;
  createdAt: Date;
  /** True when an `idempotencyKey` replay returned the original fill. */
  replayed: boolean;
}

// ---------------------------------------------------------------------------
// reading the share vector
// ---------------------------------------------------------------------------

interface Board {
  /** Share quantities as floats, indexed by `ordinal`. */
  q: number[];
  /** Outcome rows in `ordinal` order. */
  rows: (typeof outcomes.$inferSelect)[];
  b: number;
}

async function readBoard(ex: Executor, market: typeof markets.$inferSelect): Promise<Board> {
  const rows = await ex.select().from(outcomes).where(eq(outcomes.marketId, market.id)).orderBy(asc(outcomes.ordinal));
  return boardFromOutcomes(market, rows);
}

/** Build the engine's validated board from batched reads, without another database round trip. */
export function boardFromOutcomes(market: Pick<schema.Market, 'id' | 'b'>, rows: schema.Outcome[]): Board {
  if (rows.length < 2) {
    throw new EngineError('invalid_market', `market ${market.id} has ${rows.length} outcomes`);
  }
  // The cost function is indexed by ordinal, so the vector must be dense and
  // in order. A gap would silently reprice the wrong outcome.
  rows.forEach((row, i) => {
    if (row.ordinal !== i) {
      throw new EngineError('invalid_market', `market ${market.id} has a gap in its ordinals`);
    }
  });

  return { rows, b: market.b, q: rows.map((r) => microToFloat(r.sharesMicro)) };
}

function priceOne(shares: number[], b: number, index: number): number {
  return prices(shares, b)[index];
}

// ---------------------------------------------------------------------------
// market creation — where b is computed, once, and frozen
// ---------------------------------------------------------------------------

export interface CreateMarketInput {
  slug: string;
  question: string;
  description?: string | null;
  contract?: string | null;
  kind?: string;
  outcomes: string[];
  closesAt: Date;
  opensAt?: Date | null;
  resolutionSource?: string | null;
  createdBy?: string | null;
  /** The starting balance a trader gets, in micro-units. Sizes `b`. */
  startingBalanceMicro: bigint;
  /** The expected field. Sizes `b`. */
  expectedTraders: number;
  /** `open` unless you want to stage it. */
  status?: 'draft' | 'open';
  /** The opaque listing this market belongs to, if any. Display grouping only. */
  listingId?: string | null;
  /** Order within the listing; 0 is its main market. */
  listingRank?: number;
  /**
   * The prices the market opens at, one per outcome, positive, summing to 1
   * (within rounding). Left out, every outcome opens at 1/n. A prior is a
   * stake in what the answer probably is, and the house pays for it: see the
   * subsidy below.
   */
  openingPrices?: number[];
}

export async function createMarket(
  input: CreateMarketInput,
  database: Db = getDb(),
): Promise<{ marketId: string; outcomeIds: string[]; b: number; subsidyMicro: bigint }> {
  if (input.outcomes.length < 2) {
    throw new EngineError('invalid_market', 'a market needs at least two outcomes');
  }

  const created = await database.transaction(async (tx) => {
    const status = input.status ?? 'open';
    const listingId = input.listingId ?? null;
    const listingRank = input.listingRank ?? 0;

    /**
     * `markets.is_main`: whether this market stands for its row in browse
     * lists. A visible market with no listing always does; in a listing, the
     * visible market with the lowest rank, ties by age, so a newcomer takes
     * over only with a strictly lower rank. A draft never does.
     *
     * Serialized per listing by an advisory lock, so two markets created at
     * once cannot both see no main market (the unique index on
     * `(listing_id) where is_main` would refuse the second anyway). Done
     * before the treasury lock: demoting the old main market locks its row,
     * and markets are always locked before accounts.
     */
    let isMain = status !== 'draft' && listingId === null;
    if (status !== 'draft' && listingId !== null) {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${listingId}::text, 0))`);
      const [current] = await tx
        .select({ id: markets.id, listingRank: markets.listingRank })
        .from(markets)
        .where(and(eq(markets.listingId, listingId), eq(markets.isMain, true)));
      isMain = !current || listingRank < current.listingRank;
      if (isMain && current) {
        await tx.update(markets).set({ isMain: false }).where(eq(markets.id, current.id));
      }
    }

    const [treasury] = await tx.select().from(accounts).where(eq(accounts.handle, HOUSE_HANDLE)).for('update');
    if (!treasury) {
      throw new EngineError('not_found', `no house account with handle "${HOUSE_HANDLE}"`);
    }

    /**
     * Invariant §1.3: `b` is computed **here, once**, and then frozen. It is
     * sized from the expected field and the starting balance, because a `b`
     * small enough for one trader to pin the price makes the market that
     * trader's opinion.
     *
     * Nothing anywhere else may write `markets.b`. Recomputing it mid-market
     * changes the cost function under existing positions and lets a trader
     * extract reputation from the transition; a `b` that grows with volume is
     * a different formula (liquidity-sensitive LMSR) with different
     * invariants, and it is out of scope.
     */
    const b = liquidityFor(microToFloat(input.startingBalanceMicro), input.expectedTraders, input.outcomes.length);

    /**
     * The opening share vector. Uniform: all zeros. With a prior, the vector
     * that prices at it, `openingShares`: non-negative, the least likely
     * outcome at 0, rounded to micro-shares once so the stored integers are
     * what everything after prices from. Stored on the outcomes as both the
     * live `shares_micro` and the `opening_shares_micro` every replay starts
     * from. Traders hold none of it: positions, and so settlement, only ever
     * see what was traded.
     */
    const prior = input.openingPrices;
    if (prior) {
      const total = prior.reduce((a, p) => a + p, 0);
      if (
        prior.length !== input.outcomes.length ||
        prior.some((p) => !(p > 0) || !Number.isFinite(p)) ||
        Math.abs(total - 1) > 1e-6
      ) {
        throw new EngineError('invalid_market', 'openingPrices must be one positive price per outcome, summing to 1');
      }
    }
    const openingMicro = prior
      ? openingShares(prior, b).map((q) => BigInt(Math.round(q)))
      : input.outcomes.map(() => 0n);
    const opening = openingMicro.map(microToFloat);

    // The house's worst case, and exactly the seed the maker needs: the maker
    // starts holding C(q0), which is b·ln(n) for a uniform market and
    // b·ln(1/p_min) for one opened at a prior. That is what keeps
    // C(q) ≥ q_winner for every q ≥ q0, so the maker can still pay any winner.
    const subsidyMicro = costToMicro(cost(opening, b));
    if (treasury.balanceMicro < subsidyMicro) {
      throw new EngineError('house_underfunded', 'the house cannot cover this market subsidy', {
        requiredMicro: subsidyMicro.toString(),
        availableMicro: treasury.balanceMicro.toString(),
      });
    }

    const [maker] = await tx
      .insert(accounts)
      .values({
        handle: `market:${input.slug}`,
        displayName: `Maker — ${input.question}`,
        isHouse: true,
        balanceMicro: 0n,
      })
      .returning();

    const [market] = await tx
      .insert(markets)
      .values({
        slug: input.slug,
        question: input.question,
        description: input.description ?? null,
        contract: input.contract ?? null,
        kind: input.kind ?? 'binary',
        status,
        b,
        makerAccountId: maker.id,
        opensAt: input.opensAt ?? new Date(),
        closesAt: input.closesAt,
        resolutionSource: input.resolutionSource ?? null,
        createdBy: input.createdBy ?? null,
        listingId,
        listingRank,
        isMain,
        headline: headlinePrice(prices(opening, b)),
        // Taken after the listing lock above, not at transaction start, so a
        // market created later is never older than the main market it
        // ranks level with: `is_main` and "ties by age" stay the same order.
        createdAt: sql`clock_timestamp()`,
      })
      .returning();

    const outcomeRows = await tx
      .insert(outcomes)
      .values(
        input.outcomes.map((label, ordinal) => ({
          marketId: market.id,
          label,
          ordinal,
          sharesMicro: openingMicro[ordinal],
          openingSharesMicro: openingMicro[ordinal],
        })),
      )
      .returning();

    // The subsidy, as a balanced pair. Reputation moves; none is created.
    await creditAccount(tx, treasury.id, -subsidyMicro, 'subsidy', { marketId: market.id });
    await creditAccount(tx, maker.id, subsidyMicro, 'subsidy', { marketId: market.id });

    return {
      marketId: market.id,
      outcomeIds: outcomeRows.sort((a, c) => a.ordinal - c.ordinal).map((r) => r.id),
      b,
      subsidyMicro,
    };
  });

  // Logged after the commit, never inside it: see `server/events.ts`. The
  // treasury and maker moved, so the leaderboard's cached field is stale.
  invalidateStandings();
  invalidateMarketReads(created.marketId);
  events.log('market.created', {
    accountId: input.createdBy ?? null,
    marketId: created.marketId,
  });
  return created;
}

// ---------------------------------------------------------------------------
// quote — never writes
// ---------------------------------------------------------------------------

/**
 * Price a hypothetical trade. **Never writes.**
 *
 * This is the only honest answer to "what is this worth" (invariant §1.1): it
 * prices the whole requested size with the slippage included, whereas a mark
 * of `shares × price` is what the position is *marked at*, not what closing it
 * would pay. The two numbers are different and must stay differently named
 * everywhere they are shown together.
 *
 * A quote is **advisory**. `trade()` must never trust it: it re-prices under
 * the row lock and compares against the caller's `maxCostMicro`.
 */
export async function quote(
  marketId: string,
  outcomeId: string,
  sharesMicro: bigint,
  database: Db = getDb(),
): Promise<Quote> {
  const [market] = await database.select().from(markets).where(eq(markets.id, marketId));
  if (!market) throw new EngineError('not_found', `no market ${marketId}`);

  const board = await readBoard(database, market);
  const index = board.rows.findIndex((r) => r.id === outcomeId);
  if (index < 0) {
    throw new EngineError('not_found', `outcome ${outcomeId} is not on market ${marketId}`);
  }

  return priceTrade(board, index, sharesMicro, market.id);
}

function priceTrade(board: Board, index: number, sharesMicro: bigint, marketId: string): Quote {
  if (sharesMicro === 0n) {
    throw new EngineError('invalid_size', 'a trade of zero shares is not a trade');
  }
  const delta = microToFloat(sharesMicro);
  const after = board.q.slice();
  after[index] += delta;

  return {
    marketId,
    outcomeId: board.rows[index].id,
    outcomeLabel: board.rows[index].label,
    sharesMicro,
    // Rounded exactly once, here, on the way to the database (§1.6).
    costMicro: costToMicro(costToTrade(board.q, index, delta, board.b)),
    priceBefore: priceOne(board.q, board.b, index),
    priceAfter: priceOne(after, board.b, index),
  };
}

// ---------------------------------------------------------------------------
// trade — the whole correctness story of this app
// ---------------------------------------------------------------------------

/**
 * Buy or sell. **Selling is a trade with negative `shares`**; there is no
 * separate code path, and adding one would be a bug.
 *
 * `maxCostMicro` is the caller's slippage limit, in the same signed
 * convention as `Quote.costMicro`: for a buy it is the most the trader will
 * pay; for a sell it is the (negative) most they will accept, i.e. minus the
 * least proceeds they will take. The trade aborts if the cost re-priced under
 * the lock exceeds it.
 */
export async function trade(
  accountId: string,
  marketId: string,
  outcomeId: string,
  sharesMicro: bigint,
  maxCostMicro: bigint,
  idempotencyKey: string | null = null,
  database: Db = getDb(),
): Promise<Fill> {
  try {
    const fill = await runTrade(accountId, marketId, outcomeId, sharesMicro, maxCostMicro, idempotencyKey, database);
    // After the commit, never inside it. The log must not be able to touch a
    // row the transaction is holding. A fill moves the trader's balance and
    // every holder's exit value in this market: the cached field is stale.
    if (!fill.replayed) {
      invalidateStandings({ marketId: fill.marketId, accountId: fill.accountId });
      invalidateMarketReads(fill.marketId);
    }
    events.log('order.placed', { accountId, marketId });
    return fill;
  } catch (err) {
    // The unique index on (account_id, idempotency_key) is the real guard, and
    // it can fire when a retry races the original rather than following it.
    // Bots retry; return the original fill rather than erroring.
    if (idempotencyKey && isUniqueViolation(err)) {
      const replay = await findFillByIdempotencyKey(database, accountId, idempotencyKey);
      if (replay) return replay;
    }
    throw err;
  }
}

async function runTrade(
  accountId: string,
  marketId: string,
  outcomeId: string,
  sharesMicro: bigint,
  maxCostMicro: bigint,
  idempotencyKey: string | null,
  database: Db,
): Promise<Fill> {
  if (sharesMicro === 0n) {
    throw new EngineError('invalid_size', 'a trade of zero shares is not a trade');
  }

  return database.transaction(async (tx) => {
    /**
     * The lock. This one statement is what makes concurrent trades correct:
     * without it two traders read the same share vector and both get the
     * pre-trade price, and the difference is reputation created out of
     * nothing. It serializes **this market only** — different markets still
     * run in parallel.
     */
    const [market] = await tx.select().from(markets).where(eq(markets.id, marketId)).for('update');
    if (!market) throw new EngineError('not_found', `no market ${marketId}`);

    if (idempotencyKey) {
      const replay = await findFillByIdempotencyKey(tx, accountId, idempotencyKey);
      if (replay) return replay;
    }

    if (market.status !== 'open') {
      throw new EngineError('market_not_open', `market ${marketId} is ${market.status}`);
    }
    if (market.closesAt.getTime() <= Date.now()) {
      throw new EngineError('market_closed', `market ${marketId} closed at ${market.closesAt.toISOString()}`);
    }

    // Locked in a fixed order — market, then trader — so that concurrent
    // trades cannot deadlock. The trader's row is locked because the balance
    // check below must not race a trade of theirs on another market.
    const [account] = await tx.select().from(accounts).where(eq(accounts.id, accountId)).for('update');
    if (!account) throw new EngineError('not_found', `no account ${accountId}`);

    // Read the share vector INSIDE the lock, and re-price against it. The
    // caller's quote is advisory and is never trusted.
    const board = await readBoard(tx, market);
    const index = board.rows.findIndex((r) => r.id === outcomeId);
    if (index < 0) {
      throw new EngineError('not_found', `outcome ${outcomeId} is not on market ${marketId}`);
    }
    const priced = priceTrade(board, index, sharesMicro, marketId);

    /**
     * Slippage protection, in full. It falls out of the locking we already
     * need: re-price under the lock, compare with what the trader was shown.
     * Do not build a second mechanism.
     */
    if (priced.costMicro > maxCostMicro) {
      throw new EngineError('slippage_exceeded', 'price moved past the limit', {
        costMicro: priced.costMicro.toString(),
        maxCostMicro: maxCostMicro.toString(),
      });
    }

    if (account.balanceMicro < priced.costMicro) {
      throw new EngineError('insufficient_balance', 'not enough reputation', {
        costMicro: priced.costMicro.toString(),
        balanceMicro: account.balanceMicro.toString(),
      });
    }

    const [held] = await tx
      .select()
      .from(positions)
      .where(and(eq(positions.accountId, accountId), eq(positions.outcomeId, outcomeId)))
      .for('update');
    const heldMicro = held?.sharesMicro ?? 0n;

    /**
     * No naked shorts. A trader may only sell what they hold.
     *
     * The plan is silent on this and it is not cosmetic: an unbacked short
     * takes the proceeds now and owes 1 unit per share at settlement, which is
     * how an account ends up with a negative balance and how the maker ends up
     * unable to pay. Keeping every `q_i ≥ 0` is also exactly what keeps the
     * maker's balance `C(q) ≥ b·ln(n) > 0`.
     */
    if (sharesMicro < 0n && heldMicro + sharesMicro < 0n) {
      throw new EngineError('insufficient_shares', 'cannot sell more shares than are held', {
        heldMicro: heldMicro.toString(),
        sellingMicro: (-sharesMicro).toString(),
      });
    }

    await tx
      .update(outcomes)
      .set({ sharesMicro: sql`${outcomes.sharesMicro} + ${sharesMicro}` })
      .where(eq(outcomes.id, outcomeId));

    const [order] = await tx
      .insert(orders)
      .values({
        accountId,
        marketId,
        outcomeId,
        sharesMicro,
        costMicro: priced.costMicro,
        priceBefore: priced.priceBefore,
        priceAfter: priced.priceAfter,
        idempotencyKey,
      })
      .returning();

    // The browse caches (`markets.volume_micro` …), on the row this
    // transaction already holds: no new lock, and never out of step.
    const after = board.q.slice();
    after[index] += microToFloat(sharesMicro);
    await tx
      .update(markets)
      .set({
        volumeMicro: sql`${markets.volumeMicro} + ${priced.costMicro < 0n ? -priced.costMicro : priced.costMicro}`,
        orderCount: sql`${markets.orderCount} + 1`,
        // The fill's own timestamp at full precision; a JS Date has only ms.
        lastTradeAt: sql`(select ${orders.createdAt} from ${orders} where ${orders.id} = ${order.id})`,
        headline: headlinePrice(prices(after, board.b)),
      })
      .where(eq(markets.id, marketId));

    // The balanced pair: what the trader pays, the maker receives.
    const balanceAfterMicro = await creditAccount(tx, accountId, -priced.costMicro, 'trade', {
      orderId: order.id,
      marketId,
    });
    await creditAccount(tx, market.makerAccountId, priced.costMicro, 'trade', {
      orderId: order.id,
      marketId,
    });

    const [position] = await tx
      .insert(positions)
      .values({ accountId, outcomeId, sharesMicro })
      .onConflictDoUpdate({
        target: [positions.accountId, positions.outcomeId],
        set: { sharesMicro: sql`${positions.sharesMicro} + ${sharesMicro}` },
      })
      .returning();

    /**
     * A sell shrinks the position, and comment backings are claims on it:
     * Σ backings for (account, outcome) must stay ≤ the position. Trim the
     * excess newest first (LIFO), here, in the trade's own transaction, so no
     * one ever sees a backing the shares no longer cover.
     *
     * The one write the engine makes outside market state. It is bound to
     * the position, not to the market: no reputation moves. It takes no new
     * lock order — the market and account rows are already held, and
     * `server/backings.ts` locks the same account row before it inserts, so
     * a backing and a sell on one account serialize on that row.
     */
    if (sharesMicro < 0n) {
      const backed = await tx
        .select({ id: commentBackings.id, sharesMicro: commentBackings.sharesMicro })
        .from(commentBackings)
        .where(and(eq(commentBackings.accountId, accountId), eq(commentBackings.outcomeId, outcomeId)))
        .orderBy(desc(commentBackings.createdAt), desc(commentBackings.id))
        .for('update');
      const plan = lifoTrim(backed, position.sharesMicro);
      if (plan.remove.length > 0) {
        await tx.delete(commentBackings).where(inArray(commentBackings.id, plan.remove));
      }
      if (plan.reduce) {
        await tx
          .update(commentBackings)
          .set({ sharesMicro: plan.reduce.sharesMicro })
          .where(eq(commentBackings.id, plan.reduce.id));
      }
    }

    return {
      orderId: order.id,
      accountId,
      marketId,
      outcomeId,
      sharesMicro,
      costMicro: priced.costMicro,
      priceBefore: priced.priceBefore,
      priceAfter: priced.priceAfter,
      balanceAfterMicro,
      positionAfterMicro: position.sharesMicro,
      createdAt: order.createdAt,
      replayed: false,
    };
  });
}

async function findFillByIdempotencyKey(ex: Executor, accountId: string, idempotencyKey: string): Promise<Fill | null> {
  const [existing] = await ex
    .select()
    .from(orders)
    .where(and(eq(orders.accountId, accountId), eq(orders.idempotencyKey, idempotencyKey)));
  if (!existing) return null;

  const [account] = await ex.select().from(accounts).where(eq(accounts.id, accountId));
  const [position] = await ex
    .select()
    .from(positions)
    .where(and(eq(positions.accountId, accountId), eq(positions.outcomeId, existing.outcomeId)));

  return {
    orderId: existing.id,
    accountId,
    marketId: existing.marketId,
    outcomeId: existing.outcomeId,
    sharesMicro: existing.sharesMicro,
    costMicro: existing.costMicro,
    priceBefore: existing.priceBefore,
    priceAfter: existing.priceAfter,
    balanceAfterMicro: account?.balanceMicro ?? 0n,
    positionAfterMicro: position?.sharesMicro ?? 0n,
    createdAt: existing.createdAt,
    replayed: true,
  };
}

// ---------------------------------------------------------------------------
// settle
// ---------------------------------------------------------------------------

/**
 * Pay 1 unit per share of the winning outcome and 0 for everything else, zero
 * the positions, sweep the maker's residual back to the treasury, and mark the
 * market settled.
 *
 * **Idempotent.** It will be run twice eventually — by a retried admin call,
 * or by two clients that both saw the decision — and the second run must
 * settle nothing.
 */
export async function settle(
  marketId: string,
  winningOutcomeId: string,
  options: { evidenceUrl?: string | null } = {},
  database: Db = getDb(),
): Promise<void> {
  await database.transaction(async (tx) => {
    const [market] = await tx.select().from(markets).where(eq(markets.id, marketId)).for('update');
    if (!market) throw new EngineError('not_found', `no market ${marketId}`);

    // Idempotence: a second run settles nothing.
    if (market.status === 'settled') return;
    if (market.status === 'void') {
      throw new EngineError('invalid_market', `market ${marketId} is void`);
    }

    const board = await readBoard(tx, market);
    const winner = board.rows.find((r) => r.id === winningOutcomeId);
    if (!winner) {
      throw new EngineError('not_found', `outcome ${winningOutcomeId} is not on market ${marketId}`);
    }

    const outcomeIds = board.rows.map((r) => r.id);

    // Ordered by account id so that two settlements running at once cannot
    // take the same account rows in opposite orders and deadlock.
    const held = await tx
      .select()
      .from(positions)
      .where(inArray(positions.outcomeId, outcomeIds))
      .orderBy(asc(positions.accountId))
      .for('update');

    for (const position of held) {
      if (position.outcomeId === winningOutcomeId && position.sharesMicro !== 0n) {
        // 1 unit per share: in micro-units the payout is the share count.
        const payoutMicro = position.sharesMicro;
        await creditAccount(tx, position.accountId, payoutMicro, 'settlement', { marketId });
        await creditAccount(tx, market.makerAccountId, -payoutMicro, 'settlement', { marketId });
      }
    }

    await tx.update(positions).set({ sharesMicro: 0n }).where(inArray(positions.outcomeId, outcomeIds));

    // Whatever the maker has left is the venue's P&L on this market. Sweep it
    // back to the treasury so the maker account closes at zero and the sum of
    // all balances is untouched.
    const [maker] = await tx.select().from(accounts).where(eq(accounts.id, market.makerAccountId)).for('update');
    const [treasury] = await tx.select().from(accounts).where(eq(accounts.handle, HOUSE_HANDLE)).for('update');
    if (maker && treasury && maker.balanceMicro !== 0n) {
      const residual = maker.balanceMicro;
      await creditAccount(tx, maker.id, -residual, 'settlement', { marketId });
      await creditAccount(tx, treasury.id, residual, 'settlement', { marketId });
    }

    await tx
      .update(markets)
      .set({
        status: 'settled',
        resolvedOutcomeId: winningOutcomeId,
        resolutionEvidenceUrl: options.evidenceUrl ?? null,
        settledAt: new Date(),
        // Settled, the headline is the result's: 1 or 0 (`marketHeadline`).
        headline: headlinePrice(board.rows.map((r) => (r.id === winningOutcomeId ? 1 : 0))),
      })
      .where(eq(markets.id, marketId));
  });

  invalidateStandings({ marketId });
  invalidateMarketReads(marketId);
  events.log('market.settled', { marketId });
}

/** Close a market to trading without resolving it. Idempotent. */
export async function closeMarket(marketId: string, database: Db = getDb()): Promise<void> {
  await database.transaction(async (tx) => {
    const [market] = await tx.select().from(markets).where(eq(markets.id, marketId)).for('update');
    if (!market) throw new EngineError('not_found', `no market ${marketId}`);
    if (market.status !== 'open') return;
    await tx.update(markets).set({ status: 'closed' }).where(eq(markets.id, marketId));
  });

  invalidateMarketReads(marketId);
  events.log('market.closed', { marketId });
}

// ---------------------------------------------------------------------------
// the ledger
// ---------------------------------------------------------------------------

/**
 * Move reputation and record why, in one place.
 *
 * `accounts.balance_micro` is a **cache** of `sum(ledger_entries.delta_micro)`.
 * Both are written here, in the caller's transaction, always — which is what
 * makes the reconciliation test able to assert they agree.
 *
 * The update is `balance = balance + delta` in SQL rather than a read-modify-
 * write in JS, so it stays correct under the row lock rather than because of
 * it.
 */
export async function creditAccount(
  tx: Executor,
  accountId: string,
  deltaMicro: bigint,
  reason: (typeof schema.ledgerReason.enumValues)[number],
  refs: { orderId?: string | null; marketId?: string | null } = {},
): Promise<bigint> {
  if (deltaMicro === 0n) {
    const [row] = await tx.select().from(accounts).where(eq(accounts.id, accountId));
    return row?.balanceMicro ?? 0n;
  }

  await tx.insert(ledgerEntries).values({
    accountId,
    deltaMicro,
    reason,
    orderId: refs.orderId ?? null,
    marketId: refs.marketId ?? null,
  });

  const [updated] = await tx
    .update(accounts)
    .set({ balanceMicro: sql`${accounts.balanceMicro} + ${deltaMicro}` })
    .where(eq(accounts.id, accountId))
    .returning();

  return updated.balanceMicro;
}

/** `C(q)` for a market, in micro-units. The maker's balance should equal it. */
export async function makerValueMicro(marketId: string, database: Db = getDb()): Promise<bigint> {
  const [market] = await database.select().from(markets).where(eq(markets.id, marketId));
  if (!market) throw new EngineError('not_found', `no market ${marketId}`);
  const board = await readBoard(database, market);
  return costToMicro(cost(board.q, board.b));
}
