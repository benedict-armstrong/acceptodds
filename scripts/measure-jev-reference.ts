import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { sql } from 'drizzle-orm';
import { getDb, getPool } from '@/db';
import { askJev, JEV_MODEL, jevScore, type JevRead } from '@/server/jev';
import { marketTemplate } from '@/server/market-templates';

/**
 * Measures a venue's JEV reference sample (`venues/types.ts`, `jev.ranked`): JEV's answers to a random
 * sample of the kind's listings, asked exactly as a market is opened (`jev.askJev`), as sorted scores, one
 * sample per way JEV reads a listing. Reads the database, writes nothing to it; prints what the calls cost
 * in real money, which is not booked to `usd_costs`. Re-run it whenever the instructions, the criteria or
 * the model change, since the sample is only valid for the question it was asked.
 *
 *   npm run jev:reference -- --kind "ICLR 2027" --n 300 --out src/venues/iclr-2027.jev-reference.json
 */
async function main() {
  const { values } = parseArgs({
    options: {
      kind: { type: 'string', default: 'ICLR 2027' },
      n: { type: 'string', default: '300' },
      out: { type: 'string' },
      concurrency: { type: 'string', default: '8' },
    },
  });
  const key = process.env.NANOGPT_API_KEY;
  if (!key) throw new Error('NANOGPT_API_KEY is not set');
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');
  const template = marketTemplate(values.kind!);
  if (!template?.jev) throw new Error(`${values.kind} asks JEV nothing`);
  const jev = template.jev;
  const n = Number(values.n);

  // As many listings with a full text as without: each read gets its own sample.
  const sample = (withText: boolean) =>
    getDb().execute<{
      title: string;
      summary: string | null;
      keywords: string[];
      primaryArea: string | null;
      body: string | null;
    }>(sql`
      select l.title, l.summary, l.keywords, l.primary_area as "primaryArea", t.body
      from listings l left join listing_texts t on t.listing_id = l.id
      where l.kind = ${values.kind} and (t.listing_id is not null) = ${withText}
      order by random() limit ${n}`);
  const listings = [...(await sample(true)).rows, ...(await sample(false)).rows];

  const scores: Record<JevRead, number[]> = { fullText: [], abstract: [] };
  let cost = 0;
  let failed = 0;
  let next = 0;
  const worker = async () => {
    while (next < listings.length) {
      const l = listings[next++];
      try {
        const a = await askJev(l, l.body, { outcomes: template.outcomes, jev }, key, 60_000);
        scores[a.read].push(jevScore(a.raw));
        cost += Number(a.cost) || 0;
      } catch (err) {
        failed++;
        console.error('jev:reference:', err instanceof Error ? err.message : err);
      }
      const done = scores.fullText.length + scores.abstract.length + failed;
      if (done % 50 === 0) console.error(`jev:reference: ${done}/${listings.length}`);
    }
  };
  await Promise.all(Array.from({ length: Number(values.concurrency) }, worker));

  const sorted = (xs: number[]) => xs.map((x) => Math.round(x * 1e4) / 1e4).sort((a, b) => a - b);
  const result = {
    kind: values.kind,
    model: process.env.JEV_MODEL ?? JEV_MODEL,
    measuredAt: new Date().toISOString().slice(0, 10),
    fullText: sorted(scores.fullText),
    abstract: sorted(scores.abstract),
  };
  const json = JSON.stringify(result) + '\n';
  if (values.out) writeFileSync(values.out, json);
  else process.stdout.write(json);
  const mean = (xs: number[]) => xs.reduce((a, x) => a + x, 0) / xs.length;
  console.error(
    `jev:reference: ${scores.fullText.length} full texts (mean log-odds ${mean(scores.fullText).toFixed(2)}), ` +
      `${scores.abstract.length} abstracts (${mean(scores.abstract).toFixed(2)}), ${failed} failed, $${cost.toFixed(4)}`,
  );
}

main()
  .then(() => getPool().end())
  .catch(async (err) => {
    console.error(err);
    await getPool().end();
    process.exit(1);
  });
