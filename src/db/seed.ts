import 'dotenv/config';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { createHouse, ensureAccountForUser, startingBalanceMicro } from '@/server/accounts';
import { createAuth } from '@/server/better-auth';
import { createMarket } from '@/server/engine';
import { upsertListing } from '@/server/listings';
import { SUBSIDY_FRACTION } from '@/lib/lmsr';
import { createDb, createPool, type Database } from './index';

/**
 * The real venue (`npm run db:seed`). It **wipes every table first**, users and
 * sessions included, then creates:
 *
 * - the house, with a treasury sized to pay for every market;
 * - the admin, the first `ADMIN_EMAILS` address, funded as a signup is;
 * - one listing per ICLR 2027 submission in `data/iclr2027.sqlite` (the
 *   database `../research` builds from OpenReview; override with `--db=<path>`),
 *   each with the default single market, the four outcomes
 *   `Oral, Spotlight, Poster, Reject`, best first (issue #11 §4).
 *
 * Nothing is traded and nobody else exists: the venue opens empty. The
 * platform still knows nothing about papers: everything here goes in through
 * the same listing and engine calls `../research` would make, with the
 * submission's text, keywords and area supplied whole. Submissions are
 * anonymous until the decision, so they carry no authors.
 *
 * `--limit=<n>` loads only the first n submissions. `--traders=<n>` is the
 * expected field that sizes every market's `b` (default 100). `--decision=<date>`
 * is when decisions are released (default 2026-12-15); the markets close the
 * day before. Markets open at {@link PRIOR}, last year's split of decisions,
 * not an even one.
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

  const submissions = readSubmissions(flag('db') ?? path.join('data', 'iclr2027.sqlite'), Number(flag('limit') ?? 0));
  const traders = Number(flag('traders') ?? 100);
  const decisionAt = new Date(`${flag('decision') ?? '2026-12-15'}T00:00:00Z`);
  if (!Number.isFinite(traders) || traders < 1) throw new Error('--traders must be a positive number');
  if (Number.isNaN(decisionAt.getTime())) throw new Error('--decision must be a date like 2026-12-15');
  const closesAt = new Date(decisionAt.getTime() - 24 * 60 * 60 * 1000);

  const pool = createPool(url);
  const db = createDb(pool);

  await wipeData(db);
  // A market opening at a prior costs the house b·ln(1/p_min), with b = SUBSIDY_FRACTION · balance · traders / ln(n)
  // (§1.7); a margin covers rounding.
  const b = (SUBSIDY_FRACTION * Number(startingBalanceMicro()) * traders) / Math.log(DECISIONS.length);
  const perMarket = b * Math.log(1 / Math.min(...PRIOR));
  await createHouse(BigInt(Math.ceil(perMarket * submissions.length * 1.01)), db);
  await seedAdmin(db, adminPassword);
  await seedSubmissions(db, submissions, traders, closesAt);
  await pool.end();
}

function flag(name: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
}

function isLocal(url: string): boolean {
  return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(url).hostname);
}

/** Empties every table in `public` (users and sessions included) so the seed starts from nothing. */
async function wipeData(db: Database) {
  const { rows } = await db.execute<{ t: string }>(
    sql`select format('%I', tablename) as t from pg_tables where schemaname = 'public'`,
  );
  if (rows.length > 0) {
    await db.execute(sql.raw(`truncate table ${rows.map((r) => r.t).join(', ')} restart identity cascade`));
  }
  console.log(`wiped ${rows.length} tables`);
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

/** The four outcomes of a paper's market, best first; the headline is 1 − P(Reject). */
const DECISIONS = ['Oral', 'Spotlight', 'Poster', 'Reject'];

/**
 * The decision market's contract, shown to traders on its page. Reject is
 * every way a paper can fail to appear (#19): the client that settles the
 * market settles a withdrawal as Reject.
 */
const DECISION_CONTRACT = [
  "This market settles on the venue's final decision for the paper.",
  '',
  '- **Oral, Spotlight, Poster**: the paper is accepted in that form.',
  '- **Reject**: the paper is rejected. This also covers a paper that is withdrawn or desk-rejected before the decision.',
].join('\n');

/**
 * Where a market opens, best first like {@link DECISIONS}: ICLR 2025's
 * decisions (213 orals, 380 spotlights, 3,112 posters of 11,565 submissions).
 * The headline therefore opens at about 32%, the acceptance rate.
 */
const PRIOR = [0.018, 0.033, 0.269, 0.68];

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

async function seedSubmissions(db: Database, submissions: Submission[], traders: number, closesAt: Date) {
  const started = Date.now();
  for (const [i, s] of submissions.entries()) {
    const slug = `iclr2027-${s.number}`;
    const { listing } = await upsertListing(
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
    await createMarket(
      {
        slug: `${slug}-decision`,
        question: `How will ${KIND} decide this paper?`,
        contract: DECISION_CONTRACT,
        kind: KIND,
        outcomes: DECISIONS,
        openingPrices: PRIOR,
        closesAt,
        startingBalanceMicro: startingBalanceMicro(),
        expectedTraders: traders,
        status: 'open',
        listingId: listing.id,
        listingRank: 0,
      },
      db,
    );
    if ((i + 1) % 1000 === 0) {
      console.log(`  ${i + 1}/${submissions.length}  (${Math.round((Date.now() - started) / 1000)}s)`);
    }
  }
  console.log(`papers: ${submissions.length}, markets: ${submissions.length}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
