import 'dotenv/config';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import * as schema from './schema';

/**
 * Plain TCP `pg`. Not a serverless HTTP driver: the engine needs real
 * interactive transactions so that `SELECT ... FOR UPDATE` actually holds a
 * lock across statements.
 */
function connectionString(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL is not set (copy .env.example to .env)');
  }
  return url;
}

/**
 * `pg` parses `BIGINT` (oid 20) to a string by default, which Drizzle's
 * `mode: 'bigint'` then turns into a `bigint`. That is the behaviour we want
 * and it must not be "helpfully" overridden to `parseInt` anywhere: money is
 * never a JS number (invariant §1.6).
 */
export function createPool(url: string = connectionString()): Pool {
  return new Pool({
    connectionString: url,
    max: Number(process.env.PGPOOL_MAX ?? 10),
    // The trade transaction holds a row lock; a stuck client must not hold it
    // forever.
    statement_timeout: 15_000,
    idle_in_transaction_session_timeout: 15_000,
  });
}

export function createDb(pool: Pool) {
  return drizzle(pool, { schema });
}

export type Database = ReturnType<typeof createDb>;

declare global {
  var __papermarketPool: Pool | undefined;
}

/**
 * One pool per process, created on first use.
 *
 * Lazy on purpose: `next build` imports every route module, and a build must
 * not need a database. It is cached on `globalThis` outside production because
 * `next dev` re-evaluates modules on every edit and would otherwise exhaust
 * Postgres's connection slots within a minute.
 */
export function getPool(): Pool {
  const existing = globalThis.__papermarketPool;
  if (existing) return existing;
  const created = createPool();
  globalThis.__papermarketPool = created;
  return created;
}

let cachedDb: Database | undefined;

export function getDb(): Database {
  cachedDb ??= createDb(getPool());
  return cachedDb;
}

/** Used by `/healthz`: a 200 that never touched Postgres is not a health check. */
export async function checkDatabase(): Promise<void> {
  await getDb().execute(sql`select 1`);
}
