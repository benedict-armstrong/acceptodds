import { and, asc, eq } from 'drizzle-orm';
import { getDb, type Database } from '@/db';
import { isUniqueViolation } from '@/db/errors';
import { accounts, markets, outcomes, type Account, type Listing, type Market } from '@/db/schema';
import { sharesForCost } from '@/lib/lmsr';
import { startingBalanceMicro } from './accounts';
import { ApiError } from './api/errors';
import * as engine from './engine';
import { EngineError } from './errors';
import * as follows from './follows';
import { jevPrices } from './jev';
import { marketTemplate } from './market-templates';
import { consume, rateLimitHeaders, type RateLimitConfig } from './ratelimit';

/**
 * A buy of `stakeMicro` worth of one outcome on a listing's main market,
 * opening the market first if the listing has none (the API's way; the UI
 * opens it with `openListingMarket` and then trades as usual). The venue
 * opens with no markets: each is the listing kind's template
 * (`market-templates.ts`), opened at JEV's prices (`jev.ts`) or, without an
 * answer, the template's fallback, and `created_by` is whoever opened it.
 *
 * A trader opening it here has no price to have seen, so the order is by stake, not
 * shares: sized on the board as it is once the market exists, and bounded by
 * the stake itself as `maxCostMicro`, so it never costs more than was put
 * up. It goes through `engine.trade` like every other order.
 *
 * Making the market is idempotent: two first trades at once share one
 * in-process creation, and across processes the market's slug is unique, so
 * the loser reads the winner's market and trades on it.
 */
export async function buyOnListing(
  input: {
    accountId: string;
    listing: Listing;
    outcome: string;
    stakeMicro: bigint;
    idempotencyKey: string | null;
    origin?: engine.OrderOrigin;
  },
  database: Database = getDb(),
): Promise<{ fill: engine.Fill; marketCreated: boolean }> {
  const { accountId, listing, stakeMicro, idempotencyKey } = input;
  if (stakeMicro <= 0n) throw new EngineError('invalid_size', 'the stake must be positive');

  // A retry of an order that already filled: the original, without making anything.
  if (idempotencyKey) {
    const replay = await engine.findFillByIdempotencyKey(database, accountId, idempotencyKey);
    if (replay) return { fill: replay, marketCreated: false };
  }

  let market = await mainMarket(listing.id, database);
  let marketCreated = false;
  if (!market) {
    // Checked before the market is made, so a trade that was always going
    // to fail leaves no untraded market behind. `trade()` checks again under its lock.
    const [account] = await database.select().from(accounts).where(eq(accounts.id, accountId));
    if (!account) throw new EngineError('not_found', `no account ${accountId}`);
    refuseBot(account);
    if (account.balanceMicro < stakeMicro) {
      throw new EngineError('insufficient_balance', 'not enough reputation for this order', {
        balanceMicro: account.balanceMicro.toString(),
      });
    }
    await spendOpenBudget(accountId);
    ({ market, created: marketCreated } = await ensureMainMarket(listing, accountId, database));
  }

  const rows = await database
    .select()
    .from(outcomes)
    .where(eq(outcomes.marketId, market.id))
    .orderBy(asc(outcomes.ordinal));
  const index = rows.findIndex((o) => o.label === input.outcome);
  if (index < 0) throw new EngineError('not_found', `no outcome "${input.outcome}" on market ${market.id}`);

  // Sized on the board read here; re-priced under the lock. If another fill
  // landed in between, the same shares can cost more than the stake: size
  // again on the new board rather than refuse a stake nobody quoted. A
  // paper's first minutes are when that happens, so a few times.
  for (let attempt = 0; ; attempt++) {
    const board = attempt === 0 ? rows : await outcomesOf(market.id, database);
    const sharesMicro = BigInt(
      Math.floor(
        sharesForCost(
          board.map((o) => Number(o.sharesMicro)),
          index,
          Number(stakeMicro),
          market.b,
        ),
      ),
    );
    if (sharesMicro <= 0n) throw new EngineError('invalid_size', 'the stake buys no shares');
    try {
      const fill = await engine.trade(
        accountId,
        market.id,
        rows[index].id,
        sharesMicro,
        stakeMicro,
        idempotencyKey,
        database,
        input.origin,
      );
      return { fill, marketCreated };
    } catch (err) {
      if (attempt < STAKE_ATTEMPTS - 1 && err instanceof EngineError && err.code === 'slippage_exceeded') continue;
      throw err;
    }
  }
}

/**
 * The listing's main market, opened from its template at JEV's prices
 * without a trade, for someone who asked for the opening price: the paper
 * page's "Open Market", or `/welcome` when a visitor picks a paper nobody has
 * opened; they are then asked for the first trade. `created` is false when
 * the listing already had one. Making markets spends the house's subsidy and
 * a model call, so each account may make at most {@link OPEN_BUDGET} an
 * hour (by either call: a first order opens one too), and visitors with no account (`accountId` null) {@link ANONYMOUS_OPEN_BUDGET}
 * between them; asking for one that exists costs nothing.
 */
export async function openListingMarket(
  listing: Listing,
  accountId: string | null,
  database: Database = getDb(),
): Promise<{ market: Market; created: boolean }> {
  const existing = await mainMarket(listing.id, database);
  if (existing) return { market: existing, created: false };
  if (accountId) {
    const [account] = await database.select().from(accounts).where(eq(accounts.id, accountId));
    if (account) refuseBot(account);
  }
  await spendOpenBudget(accountId);
  const opened = await ensureMainMarket(listing, accountId, database);
  // Whoever opens a paper's market follows it. Only the call that made it, so
  // a repeat open never undoes an unfollow; and after the market's commit, so a
  // failed follow costs only the follow.
  if (accountId && opened.created) {
    await follows.follow(accountId, listing.id, database).catch((err) => {
      console.error('following an opened market failed', err);
    });
  }
  return opened;
}

/**
 * Bots trade only on markets people opened: a market spends the house's
 * subsidy and a model call, and which papers have one is the humans' choice.
 * Checked before anything is spent; trading on an existing market is unaffected.
 */
function refuseBot(account: Account): void {
  if (account.isBot) {
    throw new ApiError(403, 'bots_cannot_open_markets', 'bots trade only on markets that are already open');
  }
}

/** Markets one account may open: 20 an hour, refilling steadily. */
export const OPEN_BUDGET: RateLimitConfig = { burst: 20, perSecond: 20 / 3_600 };

/**
 * One market opened, from the account's budget or, with no account, the
 * visitors' shared one: spent before anything is made, by both ways of
 * opening one (`openListingMarket`, `buyOnListing`). Past it, a 429.
 */
async function spendOpenBudget(accountId: string | null): Promise<void> {
  const budget = accountId
    ? await consume(`market-open:${accountId}`, OPEN_BUDGET)
    : await consume('market-open:anonymous', ANONYMOUS_OPEN_BUDGET);
  if (!budget.allowed) {
    throw new ApiError(
      429,
      'rate_limited',
      'too many markets opened lately; try again later',
      { retryAfterSeconds: budget.retryAfterSeconds },
      rateLimitHeaders(budget),
    );
  }
}

/**
 * Markets all visitors without an account may open a day, together: one
 * bucket, since nothing anonymous is keyed on the client. It bounds what an
 * anonymous caller can spend of the subsidy and the model; past it they are
 * asked to try again later, and signed-in traders keep their own budgets.
 */
export const ANONYMOUS_OPEN_BUDGET: RateLimitConfig = { burst: 200, perSecond: 200 / 86_400 };

/** How many times a stake is sized before its order is refused as `slippage_exceeded`. */
const STAKE_ATTEMPTS = 5;

/** The listing's main market, if it has one. */
async function mainMarket(listingId: string, database: Database): Promise<Market | null> {
  const [m] = await database
    .select()
    .from(markets)
    .where(and(eq(markets.listingId, listingId), eq(markets.isMain, true)));
  return m ?? null;
}

function outcomesOf(marketId: string, database: Database) {
  return database.select().from(outcomes).where(eq(outcomes.marketId, marketId)).orderBy(asc(outcomes.ordinal));
}

/** One creation per listing in flight in this process, shared by every first trade that arrives meanwhile. */
const inFlight = new Map<string, Promise<{ market: Market; created: boolean }>>();

/** The listing's main market, made from its template if it has none. `created` is whether this call made it. */
export async function ensureMainMarket(
  listing: Listing,
  /** Who opened it (`created_by`); null for a visitor without an account. */
  accountId: string | null,
  database: Database = getDb(),
): Promise<{ market: Market; created: boolean }> {
  const existing = await mainMarket(listing.id, database);
  if (existing) return { market: existing, created: false };
  // Only the shared database is deduplicated: a test's own transaction makes its own.
  if (database !== getDb()) return createFromTemplate(listing, accountId, database);
  let pending = inFlight.get(listing.id);
  if (!pending) {
    pending = createFromTemplate(listing, accountId, database).finally(() => inFlight.delete(listing.id));
    inFlight.set(listing.id, pending);
    return pending;
  }
  // Someone else's first trade is making it: theirs, not ours.
  return { market: (await pending).market, created: false };
}

async function createFromTemplate(
  listing: Listing,
  accountId: string | null,
  database: Database,
): Promise<{ market: Market; created: boolean }> {
  const template = marketTemplate(listing.kind);
  if (!template) {
    throw new ApiError(409, 'market_not_open', `listing ${listing.slug} has no market, and none is made for its kind`);
  }
  if (template.closesAt.getTime() <= Date.now()) {
    throw new EngineError('market_closed', `markets for ${listing.kind} closed at ${template.closesAt.toISOString()}`);
  }
  const openingPrices = (await jevPrices(listing, template, database)) ?? template.fallbackPrices;
  try {
    const { marketId } = await engine.createMarket(
      {
        slug: `${listing.slug}-decision`,
        question: template.question,
        contract: template.contract,
        kind: listing.kind ?? undefined,
        outcomes: template.outcomes,
        openingPrices,
        closesAt: template.closesAt,
        startingBalanceMicro: startingBalanceMicro(),
        expectedTraders: template.expectedTraders,
        status: 'open',
        listingId: listing.id,
        listingRank: 0,
        createdBy: accountId,
      },
      database,
    );
    const [market] = await database.select().from(markets).where(eq(markets.id, marketId));
    return { market, created: true };
  } catch (err) {
    // Another process made it first: its slug is taken. Trade on that one.
    if (isUniqueViolation(err)) {
      const made = await mainMarket(listing.id, database);
      if (made) return { market: made, created: false };
    }
    throw err;
  }
}
