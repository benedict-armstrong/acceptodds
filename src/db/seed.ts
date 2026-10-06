import 'dotenv/config';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { createHouse, ensureAccountForUser, startingBalanceMicro } from '@/server/accounts';
import { createAuth } from '@/server/better-auth';
import { upsertListing } from '@/server/listings';
import { liquidityFor } from '@/lib/lmsr';
import { microToFloat } from '@/lib/money';
import { PRICE_FLOOR } from '@/server/jev';
import { marketTemplates } from '@/server/market-templates';
import { createDb, createPool, type Database } from './index';
import { listings } from './schema';
import { wipeSeedData } from './seed-reset';

/**
 * The real venue (`npm run db:seed`). It resets trading, users and sessions,
 * preserving existing listings, bibliography, related papers and map vectors,
 * then creates:
 *
 * - the house, with a treasury sized to pay for every market;
 * - the admin, the first `ADMIN_EMAILS` address, funded as a signup is;
 * - one listing per ICLR 2027 submission in `data/iclr2027.sqlite` (the
 *   database `../research` builds from OpenReview; override with `--db=<path>`),
 *   with **no market**: a listing's market is opened on demand
 *   (`server/market-start.ts`), from its kind's template.
 *
 * Nothing is traded and nobody else exists: the venue opens empty. The
 * platform still knows nothing about papers: everything here goes in through
 * the same listing call `../research` would make, with the submission's text,
 * keywords and area supplied whole. Submissions are anonymous until the
 * decision, so they carry no authors.
 *
 * `--limit=<n>` loads only the first n submissions. The treasury is sized to
 * open every listing's market at the worst prior JEV can give
 * (`jev.PRICE_FLOOR`).
 * Existing listings are reused without reading SQLite. An empty database is
 * loaded from SQLite. `--keep-listings` explicitly requires the reuse path;
 * `--reset-listings` opts into wiping paper data and loading SQLite again.
 * `--db` and `--limit` require `--reset-listings`.
 * All trading and account data is still wiped in either mode.
 *
 * Only a local database is wiped unless `--allow-remote` is passed; a remote
 * seed also needs `SEED_ADMIN_PASSWORD` (a local one defaults to
 * `ADMIN_PASSWORD`).
 */
async function main() {
  const url = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const local = isLocal(url);
  if (!local && !process.argv.includes('--allow-remote')) {
    throw new Error(
      `refusing to wipe ${new URL(url).hostname}: only a local database is seeded without --allow-remote`,
    );
  }
  const adminPassword = process.env.SEED_ADMIN_PASSWORD || (local ? ADMIN_PASSWORD : '');
  if (!adminPassword) throw new Error('SEED_ADMIN_PASSWORD is required to seed a remote database');

  const resetListings = process.argv.includes('--reset-listings');
  const explicitKeep = process.argv.includes('--keep-listings');
  if (resetListings && explicitKeep) {
    throw new Error('--reset-listings cannot be combined with --keep-listings');
  }
  if (!resetListings && (flag('db') !== undefined || flag('limit') !== undefined)) {
    throw new Error('--db and --limit require --reset-listings (which deletes existing paper data)');
  }
  const pool = createPool(url);
  const db = createDb(pool);
  const existingListings = !resetListings
    ? await db.select({ id: listings.id, slug: listings.slug, kind: listings.kind }).from(listings)
    : [];
  const keepListings = explicitKeep || (!resetListings && existingListings.length > 0);
  const submissions = keepListings
    ? []
    : readSubmissions(flag('db') ?? path.join('data', 'iclr2027.sqlite'), Number(flag('limit') ?? 0));
  const listingCount = keepListings ? existingListings.length : submissions.length;

  await wipeSeedData(db, !resetListings);
  await createHouse(BigInt(Math.ceil(worstSubsidyMicro() * listingCount * 1.01)), db);
  await seedAdmin(db, adminPassword);
  if (keepListings) console.log(`papers preserved: ${listingCount}, markets: none until traded`);
  else await seedSubmissions(db, submissions);
  await pool.end();
}

/**
 * The most the house can pay to open one listing's market (§1.7): b·ln(1/p_min),
 * with p_min the floor under every opening price, for the costliest template.
 */
function worstSubsidyMicro(): number {
  const balance = microToFloat(startingBalanceMicro());
  return Math.max(
    0,
    ...marketTemplates().map(
      (t) => liquidityFor(balance, t.expectedTraders, t.outcomes.length) * Math.log(1 / PRICE_FLOOR),
    ),
  );
}

function flag(name: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
}

function isLocal(url: string): boolean {
  return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(url).hostname);
}

/** Default password of the seeded admin on a local database. */
const ADMIN_PASSWORD = 'testtesttest';

/**
 * A confirmed, funded user for the first `ADMIN_EMAILS` address, who can sign
 * in with `password`. Inserted through Better Auth's own adapter, so the
 * password hash is its format, but past the sign-up hook and the confirmation
 * mail.
 */
async function seedAdmin(db: Database, password: string) {
  const email = (process.env.ADMIN_EMAILS ?? '').split(',')[0]?.trim().toLowerCase();
  if (!email) {
    console.log('ADMIN_EMAILS is empty; no admin user seeded');
    return null;
  }
  const ctx = await createAuth(db).$context;
  const user = await ctx.internalAdapter.createUser(
    { email, name: 'Admin', emailVerified: true },
    { method: 'email-password' },
  );
  await ctx.internalAdapter.linkAccount({
    userId: user.id,
    providerId: 'credential',
    accountId: user.id,
    password: await ctx.password.hash(password),
  });
  const account = await ensureAccountForUser({ id: user.id, name: user.name, email }, db);
  const shown = password === ADMIN_PASSWORD ? ` password ${password}` : '';
  console.log(`admin       ${email}  (${account.handle})${shown}`);
  return account;
}

// ---------------------------------------------------------------------------
// submissions
// ---------------------------------------------------------------------------

const KIND = 'ICLR 2027';

interface Submission {
  id: string;
  number: number;
  title: string;
  abstract: string;
  keywords: string[];
  primaryArea: string | null;
  tldr: string | null;
}

/** The submissions in the research database, in submission order, without OpenReview's test note. */
function readSubmissions(file: string, limit: number): Submission[] {
  if (!existsSync(file))
    throw new Error(`${file} not found: copy ../research/data/iclr2027.sqlite there or pass --db=`);
  const sqlite = new DatabaseSync(file, { readOnly: true });
  const rows = sqlite
    .prepare(
      `select id, number, title, abstract, keywords, primary_area, tldr from submissions
       where coalesce(title, '') <> '' and title <> 'Internal Test' order by number ${limit > 0 ? `limit ${limit | 0}` : ''}`,
    )
    .all() as Record<string, string | number | null>[];
  sqlite.close();
  return rows.map((r) => ({
    id: String(r.id),
    number: Number(r.number),
    title: String(r.title).trim(),
    abstract: String(r.abstract ?? '').trim(),
    keywords: parseList(r.keywords),
    primaryArea: String(r.primary_area ?? '').trim() || null,
    tldr: String(r.tldr ?? '').trim() || null,
  }));
}

function parseList(json: string | number | null): string[] {
  try {
    const xs = JSON.parse(String(json ?? '[]'));
    return Array.isArray(xs) ? xs.map((x) => String(x).trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
}

async function seedSubmissions(db: Database, submissions: Submission[]) {
  const started = Date.now();
  for (const [i, s] of submissions.entries()) {
    const slug = `iclr2027-${s.number}`;
    await upsertListing(
      {
        slug,
        title: s.title,
        summary: s.abstract || null,
        tldr: s.tldr,
        keywords: s.keywords,
        primaryArea: s.primaryArea,
        links: [
          { label: 'OpenReview', url: `https://openreview.net/forum?id=${s.id}` },
          { label: 'PDF', url: `https://openreview.net/pdf?id=${s.id}` },
        ],
        kind: KIND,
      },
      db,
    );
    reportProgress(i + 1, submissions.length, started);
  }
  console.log(`papers: ${submissions.length}, markets: none until traded`);
}

function reportProgress(done: number, total: number, started: number) {
  if (done % 1000 === 0) {
    console.log(`  ${done}/${total}  (${Math.round((Date.now() - started) / 1000)}s)`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
