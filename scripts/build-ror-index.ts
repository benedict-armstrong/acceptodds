import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { buildRorIndex } from '@/server/ror';

/**
 * Compact a ROR data dump into the domain index the app reads (§8).
 *
 *   1. Download the latest dump from https://zenodo.org/communities/ror-data
 *      (a zip holding `vX.Y-YYYY-MM-DD-ror-data_schema_v2.json`) and unzip it.
 *   2. npm run ror:index -- path/to/…ror-data_schema_v2.json data/ror-index.json
 *   3. Point ROR_INDEX_PATH at the output (bake it into the image or mount it).
 *
 * Re-run whenever you refresh the dump; ROR publishes roughly monthly.
 */
const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error('usage: npm run ror:index -- <ror-data_schema_v2.json> <index.json>');
  process.exit(1);
}
const records = JSON.parse(readFileSync(input, 'utf8'));
if (!Array.isArray(records)) throw new Error(`${input} is not a ROR dump (expected a JSON array)`);
const index = buildRorIndex(records, basename(input));
writeFileSync(output, JSON.stringify(index));
console.log(`${records.length} organisations -> ${Object.keys(index.domains).length} domains in ${output}`);
