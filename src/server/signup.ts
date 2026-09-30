import { eq } from 'drizzle-orm';
import { getDb, type Database } from '@/db';
import { user } from '@/db/auth-schema';
import { isUniqueViolation } from '@/db/errors';
import { ApiError } from './api/errors';
import { normalizeEmail } from './affiliations';
import { getAuth, mailAlreadyRegistered } from './better-auth';
import { institutionForEmail } from './institution-domains';
import { consume, rateLimitHeaders, type RateLimitConfig } from './ratelimit';

/**
 * Signing up, by `/signup` (`POST /signup`) or by onboarding
 * (`POST /onboarding`): an email and a name, **never a password**. The user
 * is made with no credential, and the address is mailed a confirmation link
 * and code. The password is chosen only after confirming
 * (`/signin/continue`, or `/welcome`'s last step), so nobody can attach a
 * password to an address they have not proven — which is why Better Auth's
 * own `/sign-up/email` is switched off (`server/better-auth.ts`).
 *
 * Answers the same whether or not the address is taken: a confirmed one is
 * mailed a note (sign in, or choose a password) and nothing else happens.
 */

/**
 * Sign-up mails per address, from both routes together: 5, refilling over a
 * day. The routes are anonymous and send mail; the edge limits by IP, this
 * limits what any number of IPs can send to one inbox.
 */
const MAIL_BUDGET: RateLimitConfig = { burst: 5, perSecond: 5 / 86_400 };

/**
 * The unconfirmed user for `email`, made if there is none — or `null` when
 * the address is already confirmed, which has then been mailed instead.
 * Refuses an unlisted domain (422) and a spent mail budget (429). The caller
 * mails the confirmation (`sendConfirmation`), after storing anything the
 * confirmation should find.
 */
export async function claimSignUp(
  rawEmail: string,
  name: string,
  database: Database = getDb(),
): Promise<{ email: string; userId: string } | null> {
  const email = normalizeEmail(rawEmail);
  if (!institutionForEmail(email)) {
    throw new ApiError(422, 'email_domain_not_allowed', 'sign-up is open to approved institutional email domains only');
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

  let existing = await userByEmail(email, database);
  if (!existing) {
    try {
      const ctx = await getAuth().$context;
      await ctx.internalAdapter.createUser({ email, name: name.trim(), emailVerified: false }, { method: 'signup' });
    } catch (err) {
      // The same address, signing up at the same moment: the other one won.
      if (!isUniqueViolation(err)) throw err;
    }
    existing = await userByEmail(email, database);
    if (!existing) throw new Error(`user ${email} vanished after creation`);
  }
  if (existing.emailVerified) {
    await mailAlreadyRegistered(email, database);
    return null;
  }
  return { email, userId: existing.id };
}

/** The confirmation mail (link and code), whose link returns to `callbackURL`. */
export async function sendConfirmation(email: string, callbackURL: string): Promise<void> {
  await getAuth().api.sendVerificationEmail({ body: { email, callbackURL } });
}

async function userByEmail(email: string, database: Database) {
  const [row] = await database
    .select({ id: user.id, emailVerified: user.emailVerified })
    .from(user)
    .where(eq(user.email, email));
  return row ?? null;
}
