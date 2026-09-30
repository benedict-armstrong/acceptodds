import { and, asc, eq, ne, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { getDb } from '@/db';
import { user as authUser } from '@/db/auth-schema';
import * as schema from '@/db/schema';
import { accounts, affiliations, ledgerEntries, listings, markets, orders, outcomes, positions } from '@/db/schema';
import { costBasis, type Fill } from '@/lib/cost-basis';
import { prices } from '@/lib/lmsr';
import { costToMicro, microToFloat } from '@/lib/money';
import { creditAccount, HOUSE_HANDLE, quote } from './engine';
import { isUniqueViolation } from '@/db/errors';
import { EngineError } from './errors';
import { normalizeEmail, syncAccount } from './affiliations';
import { institutionForEmail } from './institution-domains';
import { invalidateStandings } from './standings-cache';
import { publicPositionIds } from './public-positions';
import { tradeFlows } from './valuation';

type Db = NodePgDatabase<typeof schema>;

export function startingBalanceMicro(): bigint {
  return BigInt(process.env.STARTING_BALANCE_MICRO ?? 1_000_000_000);
}

export interface CreateAccountInput {
  handle: string;
  displayName: string;
  userId?: string | null;
  isBot?: boolean;
  isHouse?: boolean;
  /**
   * The confirmed sign-up address, which becomes the primary affiliation and
   * verifies the account — unless another account has already confirmed it,
   * when the account is created unverified (`server/affiliations.ts`).
   */
  primaryAffiliation?: { email: string; institutionName: string } | null;
  /** Set directly, without an affiliation row: seeds and tests only. */
  institutions?: string[];
  verifiedAt?: Date | null;
  /** Defaults to `STARTING_BALANCE_MICRO`. Pass `0n` for an unfunded account. */
  grantMicro?: bigint;
}

/**
 * The **only** place reputation is created.
 *
 * Every other movement in this app is a balanced pair between two accounts, so
 * `sum(ledger_entries.delta_micro)` over the whole table equals the total
 * granted here, forever. That is what the conservation test asserts.
 */
export async function createAccount(
  input: CreateAccountInput,
  database: Db = getDb(),
): Promise<typeof accounts.$inferSelect> {
  const grant = input.grantMicro ?? startingBalanceMicro();
  const created = await database.transaction(async (tx) => {
    const [account] = await tx
      .insert(accounts)
      .values({
        handle: input.handle,
        displayName: input.displayName,
        userId: input.userId ?? null,
        isBot: input.isBot ?? false,
        isHouse: input.isHouse ?? false,
        institutions: input.institutions ?? [],
        verifiedAt: input.verifiedAt ?? null,
        balanceMicro: 0n,
      })
      .returning();

    if (input.primaryAffiliation) {
      // Any conflict here is the confirmed-address index (the account is new).
      const [primary] = await tx
        .insert(affiliations)
        .values({
          accountId: account.id,
          email: normalizeEmail(input.primaryAffiliation.email),
          institutionName: input.primaryAffiliation.institutionName,
          isPrimary: true,
          verifiedAt: sql`clock_timestamp()`,
        })
        .onConflictDoNothing()
        .returning();
      if (primary) await syncAccount(tx, account.id);
    }

    if (grant !== 0n) {
      await creditAccount(tx, account.id, grant, 'signup');
    }
    const [funded] = await tx.select().from(accounts).where(eq(accounts.id, account.id));
    return funded;
  });
  // After the commit: a new trader is on the leaderboard's field.
  invalidateStandings();
  return created;
}

/** The house treasury. Markets are subsidised out of it (invariant §1.7). */
export async function createHouse(
  grantMicro: bigint,
  database: Db = getDb(),
): Promise<typeof accounts.$inferSelect> {
  return createAccount(
    {
      handle: HOUSE_HANDLE,
      displayName: 'House',
      isHouse: true,
      grantMicro,
    },
    database,
  );
}

export async function getAccountByHandle(
  handle: string,
  database: Db = getDb(),
): Promise<typeof accounts.$inferSelect | null> {
  const [row] = await database.select().from(accounts).where(eq(accounts.handle, handle));
  return row ?? null;
}

export interface Holding {
  marketId: string;
  marketSlug: string;
  /** The market's listing ("paper"), if it has one: the UI links there. */
  listingSlug: string | null;
  /** That listing's title: what the UI names the row by. */
  listingTitle: string | null;
  question: string;
  marketStatus: (typeof schema.marketStatus.enumValues)[number];
  outcomeId: string;
  outcomeLabel: string;
  /** The outcome's place in its market, 0 = first (best), and how many there are: its colour. */
  outcomeOrdinal: number;
  outcomeCount: number;
  sharesMicro: bigint;
  /** The current implied probability of this outcome. */
  price: number;
  /**
   * `shares × price`. **This is a mark, not a sale price** (invariant §1.1).
   * It is what the position is valued at; it is not what closing it pays,
   * because the cost function moves against the seller on the way out.
   */
  markMicro: bigint;
  /**
   * What selling the whole holding right now would actually pay: a real quote
   * for the whole size, slippage included. Always ≤ `markMicro`.
   *
   * These two fields must stay separate and differently named wherever they
   * are shown. Never put `markMicro` next to a sell button on its own.
   */
  quotedExitMicro: bigint;
  /**
   * What the shares held cost, by the average-cost method over this
   * account's fills (`lib/cost-basis.ts`). How the position was entered: not
   * a value, and not what selling pays — that is `quotedExitMicro`.
   */
  costBasisMicro: bigint;
  /** The link id when the holder has made this position public (#36), else null. */
  publicPositionId: string | null;
}

export interface Portfolio {
  accountId: string;
  balanceMicro: bigint;
  holdings: Holding[];
  /**
   * `balance + Σ mark`. **Mid-market net worth is noise** (invariant §1.2): a
   * trader marking their own price impact can show a profit while holding only
   * losing positions — a real run produced 1351 from a starting 1000, all of
   * it self-inflicted. It is correct at settlement and meaningless before it.
   *
   * Never rank a leaderboard on this for an open market. It is here so that a
   * UI can show it *labelled*, not so that anything can score on it.
   */
  markedNetWorthMicro: bigint;
  /**
   * `balance + Σ quoted exit`. The honest one: a trader cannot mark their own
   * price impact into it, because the quote walks back down the same curve.
   * This is the net worth the navbar and the leaderboard show.
   */
  liquidationValueMicro: bigint;
  summary: PortfolioSummary;
}

/** The numbers above the holdings table. Same definitions as `valuation.ts`. */
export interface PortfolioSummary {
  cashMicro: bigint;
  /** Σ quoted exit. */
  holdingsValueMicro: bigint;
  /** `cash + holdings value` = `liquidationValueMicro`. */
  netWorthMicro: bigint;
  /** `holdings value + Σ trade ledger rows on markets not yet settled`. */
  unrealizedPnlMicro: bigint;
  /** Σ `trade` + `settlement` ledger rows on settled markets. */
  realizedPnlMicro: bigint;
}

export async function getPortfolio(
  accountId: string,
  database: Db = getDb(),
): Promise<Portfolio> {
  const [account] = await database.select().from(accounts).where(eq(accounts.id, accountId));
  if (!account) throw new EngineError('not_found', `no account ${accountId}`);

  const rows = await database
    .select({
      position: positions,
      outcome: outcomes,
      market: markets,
      listingSlug: listings.slug,
      listingTitle: listings.title,
    })
    .from(positions)
    .innerJoin(outcomes, eq(positions.outcomeId, outcomes.id))
    .innerJoin(markets, eq(outcomes.marketId, markets.id))
    .leftJoin(listings, eq(listings.id, markets.listingId))
    .where(and(eq(positions.accountId, accountId), ne(positions.sharesMicro, 0n)))
    .orderBy(asc(markets.slug), asc(outcomes.ordinal));

  // Every fill on an outcome still held, in the order they filled, for the
  // cost basis. One query for the whole portfolio.
  const fills = await database
    .select({ outcomeId: orders.outcomeId, sharesMicro: orders.sharesMicro, costMicro: orders.costMicro })
    .from(orders)
    .innerJoin(positions, and(eq(positions.accountId, orders.accountId), eq(positions.outcomeId, orders.outcomeId)))
    .where(and(eq(orders.accountId, accountId), ne(positions.sharesMicro, 0n)))
    .orderBy(asc(orders.createdAt), asc(orders.id));
  const fillsByOutcome = new Map<string, Fill[]>();
  for (const f of fills) {
    const list = fillsByOutcome.get(f.outcomeId) ?? [];
    list.push(f);
    fillsByOutcome.set(f.outcomeId, list);
  }

  const published = await publicPositionIds(accountId, database);
  const holdings: Holding[] = [];
  for (const row of rows) {
    const board = await database
      .select()
      .from(outcomes)
      .where(eq(outcomes.marketId, row.market.id))
      .orderBy(asc(outcomes.ordinal));
    const q = board.map((o) => microToFloat(o.sharesMicro));
    const index = board.findIndex((o) => o.id === row.outcome.id);
    const price = prices(q, row.market.b)[index];

    // The mark: shares x price. Not a sale price.
    const markMicro = costToMicro(microToFloat(row.position.sharesMicro) * price);

    // The honest one: an actual quote to close the whole position.
    const exit = await quote(row.market.id, row.outcome.id, -row.position.sharesMicro, database);

    holdings.push({
      marketId: row.market.id,
      marketSlug: row.market.slug,
      listingSlug: row.listingSlug,
      listingTitle: row.listingTitle,
      question: row.market.question,
      marketStatus: row.market.status,
      outcomeId: row.outcome.id,
      outcomeLabel: row.outcome.label,
      outcomeOrdinal: index,
      outcomeCount: board.length,
      sharesMicro: row.position.sharesMicro,
      price,
      markMicro,
      quotedExitMicro: -exit.costMicro,
      costBasisMicro: costBasis(fillsByOutcome.get(row.outcome.id) ?? []).basisMicro,
      publicPositionId: published.get(row.outcome.id) ?? null,
    });
  }

  let mark = account.balanceMicro;
  let liquid = account.balanceMicro;
  for (const h of holdings) {
    mark += h.markMicro;
    liquid += h.quotedExitMicro;
  }

  const flows = (await tradeFlows([accountId], database)).get(accountId);
  const holdingsValue = liquid - account.balanceMicro;
  return {
    accountId,
    balanceMicro: account.balanceMicro,
    holdings,
    markedNetWorthMicro: mark,
    liquidationValueMicro: liquid,
    summary: {
      cashMicro: account.balanceMicro,
      holdingsValueMicro: holdingsValue,
      netWorthMicro: liquid,
      unrealizedPnlMicro: holdingsValue + (flows?.openTradeMicro ?? 0n),
      realizedPnlMicro: flows?.realizedMicro ?? 0n,
    },
  };
}

export interface ClosedPosition {
  marketSlug: string;
  listingSlug: string | null;
  listingTitle: string | null;
  question: string;
  marketStatus: (typeof schema.marketStatus.enumValues)[number];
  outcomeId: string;
  outcomeLabel: string;
  /** Σ shares bought, over every fill. */
  boughtMicro: bigint;
  /** Σ cost of the buys. */
  paidMicro: bigint;
  /** Σ proceeds of the sells. */
  soldMicro: bigint;
  /** 1 per share still held at settlement if this outcome won, else 0. */
  payoutMicro: bigint;
  /** `soldMicro + payoutMicro − paidMicro`: exact, the ledger's own figures. */
  pnlMicro: bigint;
  /** How it closed: every share sold, or held into settlement (won or lost). */
  closedBy: 'sold' | 'won' | 'lost';
  closedAt: Date;
}

/**
 * The viewer's closed positions, newest first: every outcome they have traded
 * and now hold none of, sold out or settled. One row per outcome over its
 * whole history. Read from `orders` alone: positions change only by fills,
 * so the shares held at settlement are the net of the fills, and settlement
 * paid exactly that many units on the winner (`engine.settle`). Sums are
 * `numeric`, read as text (§1.6). Offset-paged with a total, like the home list.
 */
export async function closedPositions(
  accountId: string,
  { limit = 50, offset = 0 }: { limit?: number; offset?: number } = {},
  database: Db = getDb(),
): Promise<{ rows: ClosedPosition[]; total: number }> {
  const result = await database.execute<{
    market_slug: string;
    listing_slug: string | null;
    listing_title: string | null;
    question: string;
    status: ClosedPosition['marketStatus'];
    outcome_id: string;
    label: string;
    resolved_outcome_id: string | null;
    bought: string;
    paid: string;
    sold: string;
    net: string;
    closed_at: Date;
    total: number;
  }>(sql`
    select m.slug as market_slug, l.slug as listing_slug, l.title as listing_title, m.question, m.status,
           oc.id as outcome_id, oc.label, m.resolved_outcome_id,
           coalesce(sum(o.shares_micro) filter (where o.shares_micro > 0), 0)::text as bought,
           coalesce(sum(o.cost_micro) filter (where o.shares_micro > 0), 0)::text as paid,
           coalesce(-sum(o.cost_micro) filter (where o.shares_micro < 0), 0)::text as sold,
           sum(o.shares_micro)::text as net,
           case when m.status = 'settled' and sum(o.shares_micro) <> 0 then m.settled_at
                else max(o.created_at) end as closed_at,
           (count(*) over ())::int as total
      from orders o
      join outcomes oc on oc.id = o.outcome_id
      join markets m on m.id = o.market_id
      left join listings l on l.id = m.listing_id
      left join positions p on p.account_id = o.account_id and p.outcome_id = o.outcome_id
     where o.account_id = ${accountId}::uuid
       and coalesce(p.shares_micro, 0) = 0
     group by m.id, l.slug, l.title, oc.id
     order by closed_at desc, oc.id
     limit ${limit} offset ${offset}
  `);
  const rows = result.rows.map((r): ClosedPosition => {
    const net = BigInt(r.net);
    const settled = r.status === 'settled' && net !== 0n;
    const won = settled && r.resolved_outcome_id === r.outcome_id;
    const payoutMicro = won ? net : 0n;
    const paidMicro = BigInt(r.paid);
    const soldMicro = BigInt(r.sold);
    return {
      marketSlug: r.market_slug,
      listingSlug: r.listing_slug,
      listingTitle: r.listing_title,
      question: r.question,
      marketStatus: r.status,
      outcomeId: r.outcome_id,
      outcomeLabel: r.label,
      boughtMicro: BigInt(r.bought),
      paidMicro,
      soldMicro,
      payoutMicro,
      pnlMicro: soldMicro + payoutMicro - paidMicro,
      closedBy: !settled ? 'sold' : won ? 'won' : 'lost',
      closedAt: new Date(r.closed_at),
    };
  });
  return { rows, total: result.rows[0]?.total ?? 0 };
}

/**
 * `accounts.balance_micro` is a cache of `sum(ledger_entries.delta_micro)`.
 * This is the reconciliation: it returns every account where the two disagree,
 * and the answer must always be an empty array.
 */
export async function reconcileBalances(
  database: Db = getDb(),
): Promise<{ accountId: string; balanceMicro: bigint; ledgerMicro: bigint }[]> {
  const rows = await database
    .select({
      accountId: accounts.id,
      balanceMicro: accounts.balanceMicro,
      ledgerMicro: sql<string>`coalesce(sum(${ledgerEntries.deltaMicro}), 0)`,
    })
    .from(accounts)
    .leftJoin(ledgerEntries, eq(ledgerEntries.accountId, accounts.id))
    .groupBy(accounts.id, accounts.balanceMicro);

  return rows
    .map((r) => ({
      accountId: r.accountId,
      balanceMicro: r.balanceMicro,
      ledgerMicro: BigInt(r.ledgerMicro),
    }))
    .filter((r) => r.balanceMicro !== r.ledgerMicro);
}

// ---------------------------------------------------------------------------
// accounts for Better Auth users
// ---------------------------------------------------------------------------

/**
 * A handle from a display name: `[a-z0-9-]`, 3–30 chars, or `trader` when
 * the name gives fewer than 3 (none yet, or not Latin). Never from the email:
 * a handle is public (`/people/<handle>`), and an address's local part is
 * often the person's full name at their institution.
 */
export function handleFrom(name: string | null | undefined): string {
  const pick = (s: string) =>
    s
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 30)
      .replace(/-+$/, '');
  const fromName = pick(name ?? '');
  const base = fromName.length >= 3 ? fromName : 'trader';
  // `market:` and `house` are the engine's; a UUID-shaped handle would be confusing.
  return base === 'house' ? 'house-trader' : base;
}

/**
 * The trader row for a Better Auth user whose email is **confirmed**,
 * creating it if it does not exist yet — with the signup grant, and verified
 * against the institution allowlist. **Idempotent**, and safe to race: the
 * unique index on `accounts.user_id` decides, and the loser reads the winner's
 * row.
 *
 * Called from Better Auth's `afterEmailVerification` and again, lazily, by
 * `server/auth.ts` for every session (a session implies a confirmed email), so
 * a user can never be signed in without an account. Never call it for an
 * unconfirmed user: the starting balance is granted on confirmation only.
 */
export async function ensureAccountForUser(
  user: { id: string; name?: string | null; email: string },
  database: Db = getDb(),
): Promise<typeof accounts.$inferSelect> {
  const [existing] = await database.select().from(accounts).where(eq(accounts.userId, user.id));
  if (existing) return existing;

  // Sign-up already refused unlisted domains; a domain removed from the list
  // since then gets an account that may browse but not trade.
  const institution = institutionForEmail(user.email);
  const base = handleFrom(user.name);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    // No name (an account made by a sign-in link): `trader-xxxx` from the
    // start, and a real handle from the first name set (`setDisplayName`).
    const handle = attempt === 0 && base !== 'trader' ? base : `${base.slice(0, 25)}-${randomSuffix()}`;
    try {
      return await createAccount(
        {
          handle,
          displayName: user.name?.trim() || handle,
          userId: user.id,
          primaryAffiliation: institution ? { email: user.email, institutionName: institution.name } : null,
        },
        database,
      );
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      const [raced] = await database.select().from(accounts).where(eq(accounts.userId, user.id));
      if (raced) return raced;
      // Otherwise the handle was taken: try another.
    }
  }
  throw new Error(`could not find a free handle for user ${user.id}`);
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 6).padEnd(4, '0');
}

/**
 * Rename a trader: `accounts.display_name`, and the Better Auth user's
 * `name` with it, so the two never disagree. The handle stays — except for
 * the first name of an account that had none (made by a sign-in link), whose
 * placeholder `trader-xxxx` handle is then made from it, once. Names are on
 * the leaderboard, so the ranked field is invalidated after the commit.
 */
export async function setDisplayName(
  account: typeof accounts.$inferSelect,
  displayName: string,
  database: Db = getDb(),
): Promise<typeof accounts.$inferSelect> {
  const name = displayName.trim();
  const [before] = account.userId
    ? await database.select({ name: authUser.name }).from(authUser).where(eq(authUser.id, account.userId))
    : [];
  const firstName = !!before && !before.name.trim();
  const base = handleFrom(name);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const handle =
      !firstName || base === 'trader' ? account.handle : attempt === 0 ? base : `${base.slice(0, 25)}-${randomSuffix()}`;
    try {
      const row = await database.transaction(async (tx) => {
        const [updated] = await tx
          .update(accounts)
          .set({ displayName: name, handle })
          .where(eq(accounts.id, account.id))
          .returning();
        if (account.userId) await tx.update(authUser).set({ name }).where(eq(authUser.id, account.userId));
        return updated;
      });
      invalidateStandings();
      return row;
    } catch (err) {
      // The handle was taken: try another.
      if (!isUniqueViolation(err) || handle === account.handle) throw err;
    }
  }
  throw new Error(`could not find a free handle for account ${account.id}`);
}
