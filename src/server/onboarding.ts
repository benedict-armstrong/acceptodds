import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { getDb, type Database } from '@/db';
import { user } from '@/db/auth-schema';
import { isUniqueViolation } from '@/db/errors';
import { markets, outcomes, pendingBets, type PendingBet } from '@/db/schema';
import { VERIFY_EMAIL } from '@/lib/return-to';
import { normalizeEmail } from './affiliations';
import { ApiError } from './api/errors';
import { startingBalanceMicro } from './accounts';
import { getAuth, mailExistingAccount } from './better-auth';
import { institutionForEmail } from './institution-domains';
import { consume, rateLimitHeaders, type RateLimitConfig } from './ratelimit';

/**
 * Onboarding (`/welcome`), the one way to sign up: someone with no account
 * picks a paper and a bet, then gives an email — no name, no password. That
 * makes a Better Auth user **without a credential or a name**, stores the
 * bet in `pending_bets`, and mails a confirmation link and code.
 *
 * Confirming creates the account and the starting balance (`ensureAccountForUser`)
 * and signs in. The person lands on `/verify-email`, which asks for the name
 * and password they lack, and places the pending bet through the API like
 * any other order, at the price then. Until they confirm there is still no
 * account and no reputation. A password is never taken before the address is
 * proven, so nobody can attach one to an address they do not own (Better
 * Auth's own `/sign-up/email` is off).
 *
 * Answers the same whether or not the address is taken: a confirmed one gets
 * a mail saying it has an account, with a sign-in link and a code, and the
 * bet is stored for it, to be placed when they sign in; an unconfirmed one gets a fresh confirmation mail and its bet
 * replaced. Either way that is harmless only because a stored bet is never
 * placed unseen: it is placed without asking only in the browser that chose
 * it (`choseHere`), and anywhere else shown first, to place or skip.
 */

export interface StartOnboarding {
  email: string;
  marketId: string;
  outcomeId: string;
  stakeMicro: bigint;
  seenOrderCount: number;
}

/**
 * Sign-up mails per address: 5, refilling over a day. The route is anonymous
 * and sends mail; the edge limits by IP, this limits what any number of IPs
 * can send to one inbox.
 */
const MAIL_BUDGET: RateLimitConfig = { burst: 5, perSecond: 5 / 86_400 };

export async function startOnboarding(
  input: StartOnboarding,
  /** The random nonce set as `ONBOARDING_BROWSER_COOKIE` in the browser that chose the bet. */
  browserNonce: string,
  database: Database = getDb(),
): Promise<void> {
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

  const email = normalizeEmail(input.email);
  if (!institutionForEmail(email)) {
    throw new ApiError(
      422,
      'email_domain_not_allowed',
      'sign-up is open to approved institutional email domains only, without a +tag',
    );
  }
  const budget = await consume(`signup-mail:${email}`, MAIL_BUDGET);
  if (!budget.allowed) {
    throw new ApiError(
      429,
      'rate_limited',
      'too many sign-up emails to this address; try again later',
      { retryAfterSeconds: budget.retryAfterSeconds },
      rateLimitHeaders(budget),
    );
  }

  const person = await userForEmail(email, database);
  const bet = {
    marketId: input.marketId,
    outcomeId: input.outcomeId,
    stakeMicro: input.stakeMicro,
    seenOrderCount: input.seenOrderCount,
    browserHash: browserHash(browserNonce),
  };
  await database
    .insert(pendingBets)
    .values({ userId: person.id, ...bet })
    .onConflictDoUpdate({ target: pendingBets.userId, set: { ...bet, createdAt: new Date() } });
  // Either way the mail lands on `/verify-email`, which places the bet.
  if (person.emailVerified) await mailExistingAccount(email, VERIFY_EMAIL);
  else await getAuth().api.sendVerificationEmail({ body: { email, callbackURL: VERIFY_EMAIL } });
}

/**
 * The user for `email`, made if there is none: no name, no credential,
 * unconfirmed. Two sign-ups at once for one address: the other one won.
 */
async function userForEmail(email: string, database: Database): Promise<{ id: string; emailVerified: boolean }> {
  const find = async () => {
    const [row] = await database
      .select({ id: user.id, emailVerified: user.emailVerified })
      .from(user)
      .where(eq(user.email, email));
    return row ?? null;
  };
  const existing = await find();
  if (existing) return existing;
  try {
    const ctx = await getAuth().$context;
    await ctx.internalAdapter.createUser({ email, name: '', emailVerified: false }, { method: 'signup' });
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
  }
  const made = await find();
  if (!made) throw new Error(`user ${email} vanished after creation`);
  return made;
}

/**
 * The cookie naming the browser a pending bet was chosen in. Anyone may
 * onboard with an unconfirmed address and replace its pending bet, so a
 * bet is placed without asking only in the browser that chose it (its hash
 * is on the bet): anywhere else it is shown first, to place or skip.
 */
export const ONBOARDING_BROWSER_COOKIE = 'onboarding_browser';

export function newBrowserNonce(): string {
  return randomBytes(24).toString('base64url');
}

function browserHash(nonce: string): string {
  return createHash('sha256').update(nonce).digest('hex');
}

/** Whether `nonce` (this browser's cookie) is the one the bet was chosen with. */
export function choseHere(bet: PendingBet, nonce: string | undefined): boolean {
  if (!nonce || !bet.browserHash) return false;
  const a = Buffer.from(bet.browserHash, 'hex');
  const b = Buffer.from(browserHash(nonce), 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The `Idempotency-Key` that places this pending bet: the same in every tab
 * and every attempt, so the engine fills it at most once (a second attempt
 * gets the original fill back, or a 409 if it was sized on another board).
 * A replaced bet is a new bet, with a new key.
 */
export function pendingBetOrderKey(bet: PendingBet): string {
  const id = createHash('sha256').update(`${bet.userId}\n${bet.createdAt.toISOString()}`).digest('hex');
  return `pending-bet:${id.slice(0, 32)}`;
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
    if (code === 'PASSWORD_ALREADY_SET')
      throw new ApiError(409, 'password_already_set', 'this account already has a password');
    if (code === 'PASSWORD_TOO_SHORT' || code === 'PASSWORD_TOO_LONG') {
      throw new ApiError(400, 'validation_error', 'password must be 12 to 128 characters');
    }
    throw err;
  }
}
