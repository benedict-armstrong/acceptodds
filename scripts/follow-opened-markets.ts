import 'dotenv/config';
import { parseArgs } from 'node:util';
import { getPool } from '@/db';
import { followOpenedListings } from '@/server/follows';

/**
 * One-off backfill: whoever opened a listing's market follows the listing
 * (`follows.followOpenedListings`), as opening it now does. A dry run unless
 * `--apply`. Unfollows were never recorded, so an opener who has since
 * unfollowed is followed again.
 *
 *   npm run follows:backfill-openers                # what it would do
 *   npm run follows:backfill-openers -- --apply
 */
async function main() {
  const { values } = parseArgs({
    options: {
      apply: { type: 'boolean', default: false },
      'database-url': { type: 'string' },
    },
  });
  if (values['database-url']) process.env.DATABASE_URL = values['database-url'];
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');
  try {
    const n = await followOpenedListings({ apply: values.apply });
    console.log(`follows:backfill-openers: ${values.apply ? 'added' : 'would add'} ${n} follows`);
    if (!values.apply) console.log('  dry run: nothing changed; pass --apply to add them');
  } finally {
    await getPool().end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
