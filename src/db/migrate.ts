import 'dotenv/config';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDb, createPool } from './index';

/**
 * Migrations run as their own step, never at container start: two app
 * replicas racing the same DDL is a bad morning.
 */
async function main() {
  const url = process.argv[2] ?? process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const pool = createPool(url);
  const db = createDb(pool);
  await migrate(db, { migrationsFolder: 'drizzle' });
  await pool.end();
  console.log(`migrations applied to ${url.replace(/:\/\/[^@]*@/, '://***@')}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
