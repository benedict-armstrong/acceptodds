import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import { getDb, type Database } from '@/db';
import { isUniqueViolation } from '@/db/errors';
import { accounts, affiliations, type Account, type Affiliation } from '@/db/schema';
import { ApiError } from './api/errors';
import { institutionForEmail } from './institution-domains';
import { sendMail } from './mail';
import { consume, rateLimitHeaders, type RateLimitConfig } from './ratelimit';
import { siteUrl } from './share';
import { invalidateStandings } from './standings-cache';

/**
 * Affiliations: the institutional email addresses an account is verified
 * through. The sign-up address is the first, the **primary** one, confirmed
 * with the account (`accounts.ensureAccountForUser`). More are added from
 * `/profile`, one address at a time, and each counts only once its own
 * 6-digit code — mailed to it and to nothing else — has been typed back.
 *
 * - Only an address on the institution allowlist can be added, and it must
 *   still be on it when confirmed.
 * - A confirmed address belongs to one account at most. Adding one that
 *   another account has confirmed looks exactly like adding a free one (the
 *   same 201, no code shown): the address's owner gets a mail saying so and
 *   no code, so nobody learns from us which addresses have accounts.
 * - The primary affiliation cannot be removed; any other can.
 * - Every add costs one unit of the account's own mail bucket,
 *   `MAIL_BUDGET`: without it, re-adding an address (which rotates its code
 *   and its five guesses) would be unlimited guessing at someone else's
 *   code, and unlimited mail to their inbox.
 *
 * `accounts.institutions` and `accounts.verified_at` are caches of the
 * confirmed rows, rewritten by `syncAccount` in the same transaction as every
 * change here, with the account row locked first, like `balance_micro`.
 * Institutions show on the leaderboard, so every change bumps the standings
 * cache after its commit.
 */

/** How long a code works. */
const CODE_TTL_MS = 60 * 60 * 1000;
/** Wrong guesses allowed against one code, of a million. */
export const MAX_CODE_ATTEMPTS = 5;
/** Unconfirmed addresses an account may have outstanding at once. */
export const MAX_PENDING = 5;
/**
 * Affiliation mails per account: 10, refilling over a day. At most ~50
 * guesses a day against a million codes, and ten mails a day to any inbox
 * per account (and every account took an institutional address to make).
 */
export const MAIL_BUDGET: RateLimitConfig = { burst: 10, perSecond: 10 / 86_400 };

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function hashCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

function newCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, '0');
}

/** This account's affiliations: the primary first, then oldest first. */
export async function listAffiliations(accountId: string, database: Database = getDb()): Promise<Affiliation[]> {
  return database
    .select()
    .from(affiliations)
    .where(eq(affiliations.accountId, accountId))
    .orderBy(desc(affiliations.isPrimary), asc(affiliations.createdAt), asc(affiliations.id));
}

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * Rewrite the account's caches from its confirmed affiliations: distinct
 * institutions, the primary's first, then by first confirmation; and
 * `verified_at` the earliest confirmation, or null when none is left.
 */
export async function syncAccount(tx: Tx | Database, accountId: string): Promise<void> {
  await tx.execute(sql`
    update accounts a
       set institutions = coalesce((
             select array_agg(i.institution_name order by i.primary_first, i.first_at, i.institution_name)
               from (select f.institution_name,
                            min(case when f.is_primary then 0 else 1 end) as primary_first,
                            min(f.verified_at) as first_at
                       from affiliations f
                      where f.account_id = a.id and f.verified_at is not null
                      group by f.institution_name) i
           ), '{}'::text[]),
           verified_at = (
             select min(f.verified_at) from affiliations f
              where f.account_id = a.id and f.verified_at is not null
           )
     where a.id = ${accountId}
  `);
}

async function lockAccount(tx: Tx, accountId: string): Promise<Account> {
  const [account] = await tx.select().from(accounts).where(eq(accounts.id, accountId)).for('update');
  if (!account) throw new ApiError(404, 'not_found', 'no such account');
  return account;
}

/**
 * Start affiliating `email` with the account: mail it a code (or, if another
 * account has confirmed it, a note and no code). Adding an address that is
 * already pending sends a fresh code; only the newest works.
 */
export async function addAffiliation(
  input: { account: Pick<Account, 'id' | 'handle'>; email: string },
  database: Database = getDb(),
): Promise<Affiliation> {
  const email = normalizeEmail(input.email);
  const institution = institutionForEmail(email);
  if (!institution) {
    throw new ApiError(
      422,
      'email_domain_not_allowed',
      'affiliations are open to approved institutional email domains only',
    );
  }
  const budget = await consume(`affiliation-mail:${input.account.id}`, MAIL_BUDGET);
  if (!budget.allowed) {
    throw new ApiError(
      429,
      'rate_limited',
      'too many affiliation emails; try again later',
      { retryAfterSeconds: budget.retryAfterSeconds },
      rateLimitHeaders(budget),
    );
  }

  const code = newCode();
  const { row, takenElsewhere } = await database.transaction(async (tx) => {
    await lockAccount(tx, input.account.id);
    const [mine] = await tx
      .select()
      .from(affiliations)
      .where(and(eq(affiliations.accountId, input.account.id), eq(affiliations.email, email)));
    if (mine?.verifiedAt)
      throw new ApiError(409, 'already_affiliated', 'this address is already one of your affiliations');

    const [elsewhere] = await tx
      .select({ id: affiliations.id })
      .from(affiliations)
      .where(and(eq(affiliations.email, email), sql`${affiliations.verifiedAt} is not null`));
    const code_ = elsewhere
      ? { codeHash: null, codeExpiresAt: null, codeAttempts: 0 }
      : { codeHash: hashCode(code), codeExpiresAt: new Date(Date.now() + CODE_TTL_MS), codeAttempts: 0 };

    if (mine) {
      const [updated] = await tx
        .update(affiliations)
        .set({ ...code_, institutionName: institution.name })
        .where(eq(affiliations.id, mine.id))
        .returning();
      return { row: updated, takenElsewhere: !!elsewhere };
    }

    const [{ pending }] = await tx
      .select({ pending: sql<number>`count(*)::int` })
      .from(affiliations)
      .where(and(eq(affiliations.accountId, input.account.id), isNull(affiliations.verifiedAt)));
    if (pending >= MAX_PENDING) {
      throw new ApiError(
        409,
        'too_many_pending',
        `confirm or remove one of your ${pending} unconfirmed addresses first`,
      );
    }
    const [created] = await tx
      .insert(affiliations)
      .values({ accountId: input.account.id, email, institutionName: institution.name, ...code_ })
      .returning();
    return { row: created, takenElsewhere: !!elsewhere };
  });

  // After the commit, so a failed send leaves a pending row that re-adding retries.
  if (takenElsewhere) {
    await sendMail({
      to: email,
      subject: 'This address is already affiliated with an acceptodds account',
      text:
        `@${input.account.handle} asked to add this address as an affiliation, but it already belongs to an account, ` +
        `so nothing was changed and no code was sent. An address can vouch for one account only.\n\n` +
        `If not, ignore this.`,
    });
  } else {
    await sendMail({
      to: email,
      subject: `${code} is your acceptodds affiliation code`,
      text:
        `@${input.account.handle} asked to add this address as an affiliation (${institution.name}). ` +
        `If that was you, enter ${code} on your profile:\n\n${siteUrl()}/profile#affiliations\n\n` +
        `It works for an hour. If not, ignore this; nothing changes without the code.`,
    });
  }
  return row;
}

type CodeFailure = 'wrong' | 'expired' | 'too_many_attempts' | 'none';

const FAILURE_MESSAGE: Record<CodeFailure, string> = {
  wrong: 'that code is not right',
  expired: 'that code has expired; send a new one',
  too_many_attempts: 'too many wrong codes; send a new one',
  none: 'no code is outstanding for this address; send a new one',
};

/**
 * Confirm a pending affiliation with its code. Confirming one already
 * confirmed returns it. A wrong code counts against the code, and after
 * `MAX_CODE_ATTEMPTS` of them only a fresh code will do.
 */
export async function verifyAffiliation(
  input: { accountId: string; id: string; code: string },
  database: Database = getDb(),
): Promise<Affiliation> {
  let outcome: { row: Affiliation } | { failure: CodeFailure };
  try {
    outcome = await database.transaction(async (tx) => {
      await lockAccount(tx, input.accountId);
      const [row] = await tx
        .select()
        .from(affiliations)
        .where(and(eq(affiliations.id, input.id), eq(affiliations.accountId, input.accountId)));
      if (!row) throw new ApiError(404, 'not_found', `no affiliation ${input.id}`);
      if (row.verifiedAt) return { row };

      if (!row.codeHash || !row.codeExpiresAt) return { failure: 'none' as const };
      if (row.codeAttempts >= MAX_CODE_ATTEMPTS) return { failure: 'too_many_attempts' as const };
      if (row.codeExpiresAt.getTime() <= Date.now()) return { failure: 'expired' as const };
      const given = Buffer.from(hashCode(input.code.trim()), 'hex');
      if (!timingSafeEqual(given, Buffer.from(row.codeHash, 'hex'))) {
        // Committed: the attempt counts even though the request fails.
        await tx
          .update(affiliations)
          .set({ codeAttempts: sql`${affiliations.codeAttempts} + 1` })
          .where(eq(affiliations.id, row.id));
        return { failure: 'wrong' as const };
      }

      // The allowlist may have changed since the code was sent.
      const institution = institutionForEmail(row.email);
      if (!institution) {
        throw new ApiError(422, 'email_domain_not_allowed', 'this address’s domain is no longer on the allowlist');
      }
      const [confirmed] = await tx
        .update(affiliations)
        .set({
          institutionName: institution.name,
          verifiedAt: sql`clock_timestamp()`,
          codeHash: null,
          codeExpiresAt: null,
          codeAttempts: 0,
        })
        .where(eq(affiliations.id, row.id))
        .returning();
      await syncAccount(tx, input.accountId);
      return { row: confirmed };
    });
  } catch (err) {
    // Another account confirmed the same address first. They proved the
    // mailbox too, so saying so leaks nothing its owner doesn't know.
    if (isUniqueViolation(err)) {
      throw new ApiError(409, 'affiliation_taken', 'another account has confirmed this address');
    }
    throw err;
  }

  if ('failure' in outcome) {
    throw new ApiError(422, 'invalid_code', FAILURE_MESSAGE[outcome.failure], { reason: outcome.failure });
  }
  invalidateStandings();
  return outcome.row;
}

/** Remove an affiliation, pending or confirmed. Never the primary one. */
export async function removeAffiliation(
  input: { accountId: string; id: string },
  database: Database = getDb(),
): Promise<void> {
  await database.transaction(async (tx) => {
    await lockAccount(tx, input.accountId);
    const [row] = await tx
      .select()
      .from(affiliations)
      .where(and(eq(affiliations.id, input.id), eq(affiliations.accountId, input.accountId)));
    if (!row) throw new ApiError(404, 'not_found', `no affiliation ${input.id}`);
    if (row.isPrimary) {
      throw new ApiError(409, 'primary_affiliation', 'the address you signed up with cannot be removed');
    }
    await tx.delete(affiliations).where(eq(affiliations.id, row.id));
    await syncAccount(tx, input.accountId);
  });
  invalidateStandings();
}
