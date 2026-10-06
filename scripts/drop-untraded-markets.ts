import 'dotenv/config';
import { parseArgs } from 'node:util';
import { getDb, getPool } from '@/db';
import { dropUntradedMarkets } from '@/db/drop-untraded';
import { formatMicro } from '@/lib/money';

/**
 * One-off migration to markets made by the first trade: deletes every
 * listing's market nobody has traded (`db/drop-untraded.ts`), so the first
 * trade makes it again at JEV's prices. A dry run unless `--apply`.
 *
 *   npm run markets:drop-untraded                       # what it would do
 *   npm run markets:drop-untraded -- --apply
 *   npm run markets:drop-untraded -- --apply --include-commented
 *
 * Restart the app afterwards: its in-process caches (the map's headlines
 * for up to an hour) still hold the deleted markets.
 */
async function main() {
  const { values } = parseArgs({
    options: {
      apply: { type: 'boolean', default: false },
      'include-commented': { type: 'boolean', default: false },
      'database-url': { type: 'string' },
    },
  });
  if (values['database-url']) process.env.DATABASE_URL = values['database-url'];
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');
  try {
    const r = await dropUntradedMarkets(getDb(), {
      apply: values.apply,
      includeCommented: values['include-commented'],
    });
    const verb = values.apply ? 'deleted' : 'would delete';
    console.log(
      `markets:drop-untraded: ${verb} ${r.markets} untraded markets (${r.comments} comments), ` +
        `${formatMicro(r.refundedMicro)} back to the treasury`,
    );
    if (r.skippedCommented > 0) {
      console.log(`  kept ${r.skippedCommented} untraded markets with comments; --include-commented deletes them too`);
    }
    if (!values.apply) console.log('  dry run: nothing changed; pass --apply to delete');
  } finally {
    await getPool().end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
