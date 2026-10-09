import { eq, sql } from 'drizzle-orm';
import { getDb, type Database } from '@/db';
import { fieldSnapshots } from '@/db/schema';
import { density } from '@/lib/distribution';
import { microToFloat } from '@/lib/money';
import { ReadCache } from './read-cache';
import { leaderboardStandings, tradedAccountIds, type LeaderboardRow } from './views';

/**
 * The field's shape for the "where you stand" curves (navbar, portfolio),
 * shared by every viewer: one row in `field_snapshots`, recomputed at most
 * every `FIELD_SNAPSHOT_MAX_AGE_SECONDS` (default 300). **Reads only**, apart
 * from its own cache row: it never touches money.
 *
 * Stale while revalidating: a read of an old snapshot returns it at once and
 * starts one background refresh, so no viewer waits for the field to be
 * valued — except the very first, when there is no row yet. A viewer places
 * themselves on it with their own live net worth (`lib/leaderboard.placeIn`),
 * so their marker is current even when the curve is minutes old. The
 * leaderboard and the API never read this: their ranks are exact.
 */

const BASIS = 'net_worth';
/** Points the curve is sampled at; the navbar takes every third. */
export const CURVE_POINTS = 120;

export interface FieldSnapshot {
  computedAt: Date;
  /** Every non-house trader's net worth at liquidation value, ascending — only those who have placed an order. */
  worthsMicro: bigint[];
  /** Kernel density at evenly spaced points across `domain`, peaking at 1. Empty for an empty field. */
  curve: number[];
  /** In units, for plotting only. */
  domain: [number, number];
}

function maxAgeMs(): number {
  const s = Number(process.env.FIELD_SNAPSHOT_MAX_AGE_SECONDS ?? 300);
  return (Number.isFinite(s) && s >= 0 ? s : 300) * 1000;
}

/** Micro-units as whole units, for plotting only. */
const toUnits = (micro: bigint) => microToFloat(micro) / 1_000_000;

const snapshotReads = new ReadCache(1);

export function clearFieldSnapshotReads(): void {
  snapshotReads.clear();
}

/** Keep the already stale-tolerant snapshot in memory; concurrent page loads share the database read. */
export function fieldSnapshot(database: Database = getDb()): Promise<FieldSnapshot> {
  return database === getDb()
    ? snapshotReads.get('field', Math.min(5_000, maxAgeMs()), () => loadFieldSnapshot(database))
    : loadFieldSnapshot(database);
}

async function loadFieldSnapshot(database: Database): Promise<FieldSnapshot> {
  const [row] = await database.select().from(fieldSnapshots).where(eq(fieldSnapshots.basis, BASIS));
  if (!row) return refreshFieldSnapshot(database);
  if (Date.now() - row.computedAt.getTime() >= maxAgeMs()) {
    // Serve this one; the next reader gets the fresh one.
    refreshFieldSnapshot(database).catch((err) => console.error('field snapshot refresh failed', err));
  }
  return {
    computedAt: row.computedAt,
    worthsMicro: row.worthsMicro,
    curve: row.curve,
    domain: [row.domainLo, row.domainHi],
  };
}

/**
 * The shape of any set of net worths, as the snapshot stores the field's:
 * sorted, with its density peaking at 1. A group's board (#25) draws its
 * members' from the live board this way; they are few, so it is not cached.
 */
export function shapeOf(worths: readonly bigint[], computedAt: Date): FieldSnapshot {
  const worthsMicro = [...worths].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  let curve: number[] = [];
  let domain: [number, number] = [0, 0];
  if (worthsMicro.length > 0) {
    const d = density(worthsMicro.map(toUnits), CURVE_POINTS);
    const peak = Math.max(...d.ys);
    curve = d.ys.map((y) => (peak > 0 ? y / peak : 0));
    domain = d.domain;
  }
  return { computedAt, worthsMicro, curve, domain };
}

/**
 * The net worths a curve draws: only accounts that have placed at least one
 * order. An account that never traded sits at its starting balance, and a
 * crowd of them there would swamp the shape of those who did.
 */
export async function tradedWorths(rows: readonly LeaderboardRow[], database: Database = getDb()): Promise<bigint[]> {
  const traded = await tradedAccountIds(
    rows.map((r) => r.accountId),
    database,
  );
  return rows.filter((r) => traded.has(r.accountId)).map((r) => r.netWorthMicro);
}

let refreshing: Promise<FieldSnapshot> | null = null;

/**
 * Value the field and store it. Concurrent calls in this process share one
 * run; a slower run from elsewhere never overwrites a newer snapshot.
 */
export function refreshFieldSnapshot(database: Database = getDb()): Promise<FieldSnapshot> {
  if (database !== getDb()) return computeAndStore(database);
  refreshing ??= computeAndStore(database).finally(() => {
    refreshing = null;
  });
  return refreshing;
}

async function computeAndStore(database: Database): Promise<FieldSnapshot> {
  // Stamped before reading, so the stamp never claims more freshness than the data has.
  const computedAt = new Date();
  const field = await leaderboardStandings({ basis: BASIS }, database);
  const { worthsMicro, curve, domain } = shapeOf(await tradedWorths(field, database), computedAt);
  const values = { computedAt, worthsMicro, curve, domainLo: domain[0], domainHi: domain[1] };
  await database
    .insert(fieldSnapshots)
    .values({ basis: BASIS, ...values })
    .onConflictDoUpdate({
      target: fieldSnapshots.basis,
      set: values,
      setWhere: sql`${fieldSnapshots.computedAt} < excluded.computed_at`,
    });
  if (database === getDb()) clearFieldSnapshotReads();
  return { computedAt, worthsMicro, curve, domain };
}
