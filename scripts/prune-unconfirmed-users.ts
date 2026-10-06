import 'dotenv/config';
import { parseArgs } from 'node:util';
import { getPool } from '@/db';
import { pruneUnconfirmedUsers, UNCONFIRMED_USER_TTL_DAYS } from '@/server/onboarding';

/**
 * Delete sign-ups never confirmed, older than a week
 * (`onboarding.pruneUnconfirmedUsers`). Run it weekly from the host's cron;
 * running it more often is harmless. For example, Sundays at 04:00:
 *
 *   0 4 * * 0  cd /srv/papermarket && npm run users:prune
 *
 *   npm run users:prune -- --older-than-days 14
 */
async function main() {
  const { values } = parseArgs({
    options: {
      'older-than-days': { type: 'string' },
      'database-url': { type: 'string' },
    },
  });
  if (values['database-url']) process.env.DATABASE_URL = values['database-url'];
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');
  const days = values['older-than-days'] === undefined ? UNCONFIRMED_USER_TTL_DAYS : Number(values['older-than-days']);
  if (!(Number.isInteger(days) && days >= 1)) throw new Error('--older-than-days must be a whole number of days, ≥ 1');
  try {
    const deleted = await pruneUnconfirmedUsers({ olderThanDays: days });
    console.log(`users:prune: deleted ${deleted} unconfirmed sign-ups older than ${days} days`);
  } finally {
    await getPool().end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
