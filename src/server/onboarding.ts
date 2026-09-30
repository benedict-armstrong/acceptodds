import { and, eq } from 'drizzle-orm';
import { getDb, type Database } from '@/db';
import { isUniqueViolation } from '@/db/errors';
import { user } from '@/db/auth-schema';
import { markets, outcomes, pendingBets, type PendingBet } from '@/db/schema';
import { WELCOME_FINISH } from '@/lib/onboarding';
import { ApiError } from './api/errors';
import { startingBalanceMicro } from './accounts';
import { normalizeEmail } from './affiliations';
import { getAuth, mailAlreadyRegistered } from './better-auth';
import { institutionForEmail } from './institution-domains';
import { consume, rateLimitHeaders, type RateLimitConfig } from './ratelimit';

/**
 * Onboarding (`/welcome`): someone with no account picks a paper and a bet,
 * then gives an email and a name — no password. That makes
 * a Better Auth user **without a credential**, stores the bet in
 * `pending_bets`, and sends the usual confirmation mail (link and code).
 *
 * Confirming creates the account and the starting balance exactly as a
 * normal sign-up does (`ensureAccountForUser`), and signs in. The person
 * lands back on `/welcome`, chooses a password there (`setPassword`), and
 * places the pending bet through the API like any other order, at the price
 * then. Until they confirm there is still no account and no reputation.
 *
 * Answers the same whether or not the address is taken: a confirmed one gets
 * a "sign in instead" mail and its bet is dropped, never added to that
 * account; an unconfirmed one gets a fresh mail and its bet replaced, which
 * is harmless because the bet is shown before it is placed.
 */

/**
 * Onboarding mails per address: 5, refilling over a day. It is an
 * unauthenticated route that sends mail; the edge limits by IP, this limits
 * what any number of IPs can send to one inbox.
 */
const MAIL_BUDGET: RateLimitConfig = { burst: 5, perSecond: 5 / 86_400 };

export interface StartOnboarding {
  email: string;
  name: string;
  marketId: string;
  outcomeId: string;
  stakeMicro: bigint;
  seenOrderCount: number;
}

export async function startOnboarding(input: StartOnboarding, database: Database = getDb()): Promise<void> {
  const email = normalizeEmail(input.email);
  if (!institutionForEmail(email)) {
    throw new ApiError(422, 'email_domain_not_allowed', 'sign-up is open to approved institutional email domains only');
  }
  if (input.stakeMicro <= 0n || input.stakeMicro > startingBalanceMicro()) {
    throw new ApiError(400, 'validation_error', 'stakeMicro must be positive and at most the starting balance');
  }
  const [target] = await database
    .select({ status: markets.status, closesAt: markets.closesAt })
    .from(outcomes)
    .innerJoin(markets, eq(markets.id, outcomes.marketId))
    .where(and(eq(outcomes.id, input.outcomeId), eq(outcomes.marketId, input.marketId)));
  if (!target) throw new ApiError(404, 'not_found', 'no such market or outcome');
  if (target.status !== 'open') throw new ApiError(409, 'market_not_open', 'this market is not open');
  if (target.closesAt.getTime() <= Date.now()) throw new ApiError(409, 'market_closed', 'this market has closed');

  const budget = await consume(`onboarding-mail:${email}`, MAIL_BUDGET);
  if (!budget.allowed) {
    throw new ApiError(
      429,
      'rate_limited',
      'too many sign-up emails to this address; try again later',
      { retryAfterSeconds: budget.retryAfterSeconds },
      rateLimitHeaders(budget),
    );
  }

  const auth = getAuth();
  let existing = await userByEmail(email, database);
  if (!existing) {
    try {
      const ctx = await auth.$context;
      await ctx.internalAdapter.createUser({ email, name: input.name.trim(), emailVerified: false }, { method: 'onboarding' });
    } catch (err) {
      // The same address, signing up at the same moment: the other one won.
      if (!isUniqueViolation(err)) throw err;
    }
    existing = await userByEmail(email, database);
    if (!existing) throw new Error(`user ${email} vanished after creation`);
  }

  if (existing.emailVerified) {
    await mailAlreadyRegistered(email, database);
    return;
  }
  const bet = {
    marketId: input.marketId,
    outcomeId: input.outcomeId,
    stakeMicro: input.stakeMicro,
    seenOrderCount: input.seenOrderCount,
  };
  await database
    .insert(pendingBets)
    .values({ userId: existing.id, ...bet })
    .onConflictDoUpdate({ target: pendingBets.userId, set: { ...bet, createdAt: new Date() } });
  await auth.api.sendVerificationEmail({ body: { email, callbackURL: WELCOME_FINISH } });
}

async function userByEmail(email: string, database: Database) {
  const [row] = await database
    .select({ id: user.id, emailVerified: user.emailVerified })
    .from(user)
    .where(eq(user.email, email));
  return row ?? null;
}

/** The user's pending bet, or `null`. */
export async function pendingBetFor(userId: string, database: Database = getDb()): Promise<PendingBet | null> {
  const [row] = await database.select().from(pendingBets).where(eq(pendingBets.userId, userId));
  return row ?? null;
}

/** Drop the user's pending bet, placed or not. Idempotent. */
export async function clearPendingBet(userId: string, database: Database = getDb()): Promise<void> {
  await database.delete(pendingBets).where(eq(pendingBets.userId, userId));
}

/**
 * Give a user who signed up through onboarding their first password. Better
 * Auth's `setPassword` is server-only, and refuses a user who already has one.
 */
export async function setFirstPassword(headers: Headers, password: string): Promise<void> {
  try {
    await getAuth().api.setPassword({ body: { newPassword: password }, headers });
  } catch (err) {
    const code = (err as { body?: { code?: string } }).body?.code;
    if (code === 'PASSWORD_ALREADY_SET') throw new ApiError(409, 'password_already_set', 'this account already has a password');
    if (code === 'PASSWORD_TOO_SHORT' || code === 'PASSWORD_TOO_LONG') {
      throw new ApiError(400, 'validation_error', 'password must be 12 to 128 characters');
    }
    throw err;
  }
}
