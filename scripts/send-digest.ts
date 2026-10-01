import 'dotenv/config';
import { parseArgs } from 'node:util';
import { getPool } from '@/db';
import { sendDailyDigest } from '@/server/digest';

/**
 * Send today's digest of followed papers that moved. Run it once a day from
 * the host's cron; it is safe to run twice (a second run the same day sends
 * nothing). For example, 07:00 in Zurich:
 *
 *   CRON_TZ=Europe/Zurich
 *   0 7 * * *  cd /srv/papermarket && npm run digest:send
 *
 *   npm run digest:send -- --min-move-pp 10
 *
 * Exits non-zero if any mail failed, so cron reports it; those accounts can be
 * retried by running it again the same day.
 */
async function main() {
  const { values } = parseArgs({
    options: {
      'min-move-pp': { type: 'string' },
      'database-url': { type: 'string' },
    },
  });
  if (values['database-url']) process.env.DATABASE_URL = values['database-url'];
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');
  const min = values['min-move-pp'] === undefined ? undefined : Number(values['min-move-pp']);
  if (min !== undefined && !(Number.isFinite(min) && min > 0))
    throw new Error('--min-move-pp must be a positive number');
  try {
    const r = await sendDailyDigest({ minMovePp: min });
    console.log(
      `digest ${r.day}: considered=${r.considered} sent=${r.sent} already-sent=${r.skippedAlreadySent} no-moves=${r.skippedNoMoves} failed=${r.failed.length}`,
    );
    for (const f of r.failed) console.error(`  failed ${f.accountId}: ${f.error}`);
    if (r.failed.length > 0) process.exitCode = 1;
  } finally {
    await getPool().end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
