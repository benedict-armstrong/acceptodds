import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import { getDb } from '@/db';
import { accounts, institutionVerifications, type Account } from '@/db/schema';
import { ApiError } from './api/errors';
import { sendMail } from './mail';
import { institutionForDomain, loadRorIndex, type Institution } from './ror';

/**
 * Institutional verification (§8). **Ours to write**, because no product does
 * it at this scale.
 *
 *  1. The trader claims an institutional address. Its domain must resolve to
 *     an active organisation in the ROR index, or nothing is sent.
 *  2. A six-digit code goes to that address. Only an HMAC of it is stored;
 *     it expires in 15 minutes and survives 5 wrong guesses.
 *  3. Confirming the code writes `ror_id`, `institution_name` and
 *     `verified_at` onto `accounts` — which is what unlocks trading.
 *
 * Verification proves control of an address at an institution. It does not
 * prove seniority, affiliation type or anything else, and is not meant to.
 */

export const CODE_TTL_MS = 15 * 60 * 1000;
export const MAX_ATTEMPTS = 5;
export const MAX_CODES_PER_HOUR = 5;

function secret(): string {
  const s = process.env.BETTER_AUTH_SECRET;
  if (!s) throw new Error('BETTER_AUTH_SECRET is not set');
  return s;
}

function hashCode(verificationId: string, code: string): Buffer {
  return createHmac('sha256', secret()).update(`${verificationId}:${code}`).digest();
}

export async function startVerification(
  account: Account,
  email: string,
): Promise<{ id: string; email: string; institution: Institution; expiresAt: Date }> {
  const index = loadRorIndex();
  if (!index) {
    throw new ApiError(503, 'institution_directory_unavailable', 'institutional verification is not configured');
  }
  const address = email.trim().toLowerCase();
  const domain = address.split('@')[1] ?? '';
  const institution = institutionForDomain(domain, index);
  if (!institution) {
    throw new ApiError(422, 'unknown_institution', `no research organisation is registered for ${domain}`, {
      domain,
    });
  }

  const db = getDb();
  const [{ recent }] = await db
    .select({ recent: sql<number>`count(*)::int` })
    .from(institutionVerifications)
    .where(
      and(
        eq(institutionVerifications.accountId, account.id),
        gt(institutionVerifications.createdAt, sql`now() - interval '1 hour'`),
      ),
    );
  if (recent >= MAX_CODES_PER_HOUR) {
    throw new ApiError(429, 'rate_limited', 'too many verification codes requested; try again later', undefined, {
      'Retry-After': '3600',
    });
  }

  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  const expiresAt = new Date(Date.now() + CODE_TTL_MS);

  const row = await db.transaction(async (tx) => {
    // A new code supersedes any outstanding one.
    await tx
      .update(institutionVerifications)
      .set({ consumedAt: sql`now()` })
      .where(and(eq(institutionVerifications.accountId, account.id), isNull(institutionVerifications.consumedAt)));
    const [inserted] = await tx
      .insert(institutionVerifications)
      .values({
        accountId: account.id,
        email: address,
        rorId: institution.rorId,
        institutionName: institution.name,
        codeHash: 'pending',
        expiresAt,
      })
      .returning();
    await tx
      .update(institutionVerifications)
      .set({ codeHash: hashCode(inserted.id, code).toString('hex') })
      .where(eq(institutionVerifications.id, inserted.id));
    return inserted;
  });

  await sendMail({
    to: address,
    subject: `Your papermarket verification code: ${code}`,
    text:
      `Enter this code to confirm you are at ${institution.name}:\n\n    ${code}\n\n` +
      `It expires in 15 minutes. If you did not ask for it, ignore this email.`,
  });

  return { id: row.id, email: address, institution, expiresAt };
}

export async function confirmVerification(account: Account, code: string): Promise<Account> {
  const db = getDb();
  const [pending] = await db
    .select()
    .from(institutionVerifications)
    .where(and(eq(institutionVerifications.accountId, account.id), isNull(institutionVerifications.consumedAt)))
    .orderBy(desc(institutionVerifications.createdAt))
    .limit(1);
  if (!pending) throw new ApiError(404, 'not_found', 'no verification in progress; request a code first');
  if (pending.expiresAt.getTime() <= Date.now() || pending.attempts >= MAX_ATTEMPTS) {
    throw new ApiError(410, 'code_expired', 'this code has expired; request a new one');
  }

  const expected = Buffer.from(pending.codeHash, 'hex');
  const presented = hashCode(pending.id, code);
  if (expected.length !== presented.length || !timingSafeEqual(expected, presented)) {
    // Count the guess atomically, so parallel guesses cannot exceed the cap.
    const [counted] = await db
      .update(institutionVerifications)
      .set({ attempts: sql`${institutionVerifications.attempts} + 1` })
      .where(
        and(
          eq(institutionVerifications.id, pending.id),
          isNull(institutionVerifications.consumedAt),
          sql`${institutionVerifications.attempts} < ${MAX_ATTEMPTS}`,
        ),
      )
      .returning();
    const remaining = counted ? MAX_ATTEMPTS - counted.attempts : 0;
    throw new ApiError(400, 'invalid_code', 'that code is not right', { attemptsRemaining: remaining });
  }

  return db.transaction(async (tx) => {
    // Consume exactly once, even if the right code is submitted twice at once.
    const [consumed] = await tx
      .update(institutionVerifications)
      .set({ consumedAt: sql`now()` })
      .where(and(eq(institutionVerifications.id, pending.id), isNull(institutionVerifications.consumedAt)))
      .returning();
    if (!consumed) throw new ApiError(410, 'code_expired', 'this code was already used');
    const [updated] = await tx
      .update(accounts)
      .set({ rorId: consumed.rorId, institutionName: consumed.institutionName, verifiedAt: sql`now()` })
      .where(eq(accounts.id, account.id))
      .returning();
    return updated;
  });
}
