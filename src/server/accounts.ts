import { and, asc, eq, ne, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { getDb } from '@/db';
import * as schema from '@/db/schema';
import { accounts, ledgerEntries, markets, outcomes, positions } from '@/db/schema';
import { prices } from '@/lib/lmsr';
import { costToMicro, microToFloat } from '@/lib/money';
import { creditAccount, HOUSE_HANDLE, quote } from './engine';
import { isUniqueViolation } from '@/db/errors';
import { EngineError } from './errors';

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
  return database.transaction(async (tx) => {
    const [account] = await tx
      .insert(accounts)
      .values({
        handle: input.handle,
        displayName: input.displayName,
        userId: input.userId ?? null,
        isBot: input.isBot ?? false,
        isHouse: input.isHouse ?? false,
        balanceMicro: 0n,
      })
      .returning();

    if (grant !== 0n) {
      await creditAccount(tx, account.id, grant, 'signup');
    }
    const [funded] = await tx.select().from(accounts).where(eq(accounts.id, account.id));
    return funded;
  });
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
  question: string;
  marketStatus: (typeof schema.marketStatus.enumValues)[number];
  outcomeId: string;
  outcomeLabel: string;
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
  /** `balance + Σ quoted exit`. The honest one, and still not a score. */
  liquidationValueMicro: bigint;
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
    })
    .from(positions)
    .innerJoin(outcomes, eq(positions.outcomeId, outcomes.id))
    .innerJoin(markets, eq(outcomes.marketId, markets.id))
    .where(and(eq(positions.accountId, accountId), ne(positions.sharesMicro, 0n)))
    .orderBy(asc(markets.slug), asc(outcomes.ordinal));

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
      question: row.market.question,
      marketStatus: row.market.status,
      outcomeId: row.outcome.id,
      outcomeLabel: row.outcome.label,
      sharesMicro: row.position.sharesMicro,
      price,
      markMicro,
      quotedExitMicro: -exit.costMicro,
    });
  }

  let mark = account.balanceMicro;
  let liquid = account.balanceMicro;
  for (const h of holdings) {
    mark += h.markMicro;
    liquid += h.quotedExitMicro;
  }

  return {
    accountId,
    balanceMicro: account.balanceMicro,
    holdings,
    markedNetWorthMicro: mark,
    liquidationValueMicro: liquid,
  };
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

/** A handle from a display name or an email local part: `[a-z0-9-]`, 3–30 chars. */
export function handleFrom(name: string | null | undefined, email: string): string {
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
  const fromEmail = pick(email.split('@')[0] ?? '');
  const base = fromName.length >= 3 ? fromName : fromEmail.length >= 3 ? fromEmail : 'trader';
  // `market:` and `house` are the engine's; a UUID-shaped handle would be confusing.
  return base === 'house' ? 'house-trader' : base;
}

/**
 * The trader row for a Better Auth user, creating it — with the signup grant —
 * if it does not exist yet. **Idempotent**, and safe to race: the unique index
 * on `accounts.user_id` decides, and the loser reads the winner's row.
 *
 * Called from Better Auth's `user.create.after` hook and again, lazily, by
 * `server/auth.ts`, so a user can never be signed in without an account.
 */
export async function ensureAccountForUser(
  user: { id: string; name?: string | null; email: string },
  database: Db = getDb(),
): Promise<typeof accounts.$inferSelect> {
  const [existing] = await database.select().from(accounts).where(eq(accounts.userId, user.id));
  if (existing) return existing;

  const base = handleFrom(user.name, user.email);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const handle = attempt === 0 ? base : `${base.slice(0, 25)}-${randomSuffix()}`;
    try {
      return await createAccount(
        { handle, displayName: user.name?.trim() || handle, userId: user.id },
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

/** Store the ORCID iD a user signed in with on their trader row. Identity, not verification. */
export async function recordOrcid(userId: string, orcid: string, database: Db = getDb()): Promise<void> {
  const account = await database.select().from(accounts).where(eq(accounts.userId, userId));
  if (account.length === 0) return;
  try {
    await database.update(accounts).set({ orcid }).where(eq(accounts.userId, userId));
  } catch (err) {
    // The same iD already belongs to another trader; leave both as they are.
    if (!isUniqueViolation(err)) throw err;
  }
}
