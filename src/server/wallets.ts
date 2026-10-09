import { and, eq, isNull, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { getDb } from '@/db';
import * as schema from '@/db/schema';
import { ledgerEntries, wallets, type Wallet } from '@/db/schema';

/**
 * Wallets: where reputation lives, **one per account per venue** (`kind`).
 *
 * A trade in a market moves money only between the trader's and the maker's
 * wallets of that market's `kind`, so a venue's traders are funded and ranked
 * by what they did there alone. The house treasury's one wallet has no kind:
 * it subsidises every venue's markets (invariant §1.7).
 *
 * Written only here and by the engine, always in the caller's transaction.
 */

type Db = NodePgDatabase<typeof schema>;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Executor = Db | Tx;

export function startingBalanceMicro(): bigint {
  return BigInt(process.env.STARTING_BALANCE_MICRO ?? 1_000_000_000);
}

/** `kind` null is the treasury's venue-less wallet. */
function kindIs(kind: string | null) {
  return kind === null ? isNull(wallets.kind) : eq(wallets.kind, kind);
}

/** An account's wallet in a venue, or null when it has none there yet. `lock` takes it `FOR UPDATE`. */
export async function walletFor(
  ex: Executor,
  accountId: string,
  kind: string | null,
  lock = false,
): Promise<Wallet | null> {
  const query = ex
    .select()
    .from(wallets)
    .where(and(eq(wallets.accountId, accountId), kindIs(kind)));
  const [row] = lock ? await query.for('update') : await query;
  return row ?? null;
}

/**
 * Open an account's wallet in a venue, with its grant. **The only place
 * reputation is created.** Every other movement is a balanced pair between
 * two wallets, so `sum(ledger_entries.delta_micro)` over the whole table
 * equals the total granted here, forever.
 *
 * A trader's wallet opens on their first trade in the venue, with
 * `startingBalanceMicro()`, inside `trade()` under the trader's account row
 * lock, so two first trades cannot both open one. A maker's opens with its
 * market at 0.
 */
export async function openWallet(
  tx: Executor,
  accountId: string,
  kind: string | null,
  grantMicro: bigint,
): Promise<Wallet> {
  const [wallet] = await tx.insert(wallets).values({ accountId, kind, balanceMicro: 0n }).returning();
  if (grantMicro === 0n) return wallet;
  const balanceMicro = await creditWallet(tx, wallet, grantMicro, 'signup');
  return { ...wallet, balanceMicro };
}

/**
 * Move reputation and record why, in one place.
 *
 * `wallets.balance_micro` is a **cache** of `sum(ledger_entries.delta_micro)`
 * over the wallet. Both are written here, in the caller's transaction,
 * always — which is what makes the reconciliation test able to assert they
 * agree.
 *
 * The update is `balance = balance + delta` in SQL rather than a read-modify-
 * write in JS, so it stays correct under the row lock rather than because of
 * it.
 */
export async function creditWallet(
  tx: Executor,
  wallet: Pick<Wallet, 'id' | 'accountId'>,
  deltaMicro: bigint,
  reason: (typeof schema.ledgerReason.enumValues)[number],
  refs: { orderId?: string | null; marketId?: string | null } = {},
): Promise<bigint> {
  if (deltaMicro === 0n) {
    const [row] = await tx.select().from(wallets).where(eq(wallets.id, wallet.id));
    return row?.balanceMicro ?? 0n;
  }

  await tx.insert(ledgerEntries).values({
    accountId: wallet.accountId,
    walletId: wallet.id,
    deltaMicro,
    reason,
    orderId: refs.orderId ?? null,
    marketId: refs.marketId ?? null,
  });

  const [updated] = await tx
    .update(wallets)
    .set({ balanceMicro: sql`${wallets.balanceMicro} + ${deltaMicro}` })
    .where(eq(wallets.id, wallet.id))
    .returning();

  return updated.balanceMicro;
}

/**
 * What an account has to spend in a venue: its wallet's balance, or the
 * starting grant its first trade there would open the wallet with.
 */
export async function cashIn(accountId: string, kind: string, database: Db = getDb()): Promise<bigint> {
  return (await walletFor(database, accountId, kind))?.balanceMicro ?? startingBalanceMicro();
}

/** Every wallet of an account, venues by name (byte order, the same whatever the database's locale). */
export async function walletsOf(accountId: string, database: Db = getDb()): Promise<Wallet[]> {
  return database
    .select()
    .from(wallets)
    .where(eq(wallets.accountId, accountId))
    .orderBy(sql`${wallets.kind} collate "C"`);
}

/**
 * `wallets.balance_micro` is a cache of `sum(ledger_entries.delta_micro)`.
 * This is the reconciliation: it returns every wallet where the two
 * disagree, and the answer must always be an empty array.
 */
export async function reconcileBalances(
  database: Db = getDb(),
): Promise<{ walletId: string; accountId: string; balanceMicro: bigint; ledgerMicro: bigint }[]> {
  const rows = await database
    .select({
      walletId: wallets.id,
      accountId: wallets.accountId,
      balanceMicro: wallets.balanceMicro,
      ledgerMicro: sql<string>`coalesce(sum(${ledgerEntries.deltaMicro}), 0)`,
    })
    .from(wallets)
    .leftJoin(ledgerEntries, eq(ledgerEntries.walletId, wallets.id))
    .groupBy(wallets.id, wallets.accountId, wallets.balanceMicro);

  return rows
    .map((r) => ({
      walletId: r.walletId,
      accountId: r.accountId,
      balanceMicro: r.balanceMicro,
      ledgerMicro: BigInt(r.ledgerMicro),
    }))
    .filter((r) => r.balanceMicro !== r.ledgerMicro);
}
