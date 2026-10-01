import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { getDb, type Database } from '@/db';
import { markets, outcomes, pendingBets, type PendingBet } from '@/db/schema';
import { WELCOME_FINISH } from '@/lib/onboarding';
import { ApiError } from './api/errors';
import { startingBalanceMicro } from './accounts';
import { getAuth } from './better-auth';
import { claimSignUp, sendConfirmation } from './signup';

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
 * account; an unconfirmed one gets a fresh mail and its bet replaced. That
 * is harmless only because a replaced bet is never placed unseen: it is
 * placed without asking only in the browser that chose it (`choseHere`).
 * The sign-up itself is `server/signup.ts`, shared with `POST /signup`.
 */

export interface StartOnboarding {
  email: string;
  name: string;
  marketId: string;
  outcomeId: string;
  stakeMicro: bigint;
  seenOrderCount: number;
}

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

  const claimed = await claimSignUp(input.email, input.name, database);
  if (!claimed) return; // already confirmed: mailed instead, and the bet is dropped
  const bet = {
    marketId: input.marketId,
    outcomeId: input.outcomeId,
    stakeMicro: input.stakeMicro,
    seenOrderCount: input.seenOrderCount,
    browserHash: browserHash(browserNonce),
  };
  await database
    .insert(pendingBets)
    .values({ userId: claimed.userId, ...bet })
    .onConflictDoUpdate({ target: pendingBets.userId, set: { ...bet, createdAt: new Date() } });
  await sendConfirmation(claimed.email, WELCOME_FINISH);
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
