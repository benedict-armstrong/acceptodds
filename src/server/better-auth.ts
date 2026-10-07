import { randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { betterAuth } from 'better-auth';
import { APIError } from 'better-auth/api';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { emailOTP } from 'better-auth/plugins/email-otp';
import { magicLink } from 'better-auth/plugins/magic-link';
import { apiKey } from '@better-auth/api-key';
import { getDb, type Database } from '@/db';
import * as authSchema from '@/db/auth-schema';
import { CLIENT_IP_HEADER } from './api/http';
import { ensureAccountForUser } from './accounts';
import { institutionForEmail } from './institution-domains';
import { consume, type RateLimitConfig } from './ratelimit';
import { confirmationMail, existingAccountMail, magicLinkMail, passwordMail } from '@/lib/auth-mails';
import { sendMail } from './mail';

/**
 * Better Auth, mounted in-app with its tables in our Postgres
 * (IMPLEMENTATION.md §8). It owns identity — users, sessions, email
 * verification and API keys. It does **not** own traders: `accounts` is ours,
 * one row per Better Auth `user`.
 *
 * Sign-up is by email alone (`server/onboarding.ts`), and only from an address whose domain is on
 * the institution allowlist (`server/institution-domains.ts`). The trader
 * account — and with it the starting balance — is created only when that
 * address is **confirmed**, which is also what marks the account verified.
 * One mail confirms it two ways: a link, and a 6-digit code typed into
 * `/verify-email` in the tab the person signed up in (issue #15), so they are never
 * stuck on a "check your inbox" page or sent to a new tab.
 *
 * Nothing outside `server/auth.ts` should ask this module who a request is.
 */

export const API_KEY_PREFIX = 'pm_live_';

/**
 * Scopes are stored as the plugin's permissions, on one resource: `{ api:
 * ['read', 'trade'] }`. Checked by `server/auth.ts`, not by the plugin, so a
 * missing scope is a 403 and not an indistinguishable 401.
 */
export const API_KEY_RESOURCE = 'api';

function baseURL(): string {
  const url = process.env.BETTER_AUTH_URL ?? process.env.APP_URL;
  if (!url) throw new Error('BETTER_AUTH_URL is not set');
  return url;
}

/** Thrown from the sign-up hook; Better Auth returns it as a 422 with this code. */
export const EMAIL_DOMAIN_NOT_ALLOWED = 'EMAIL_DOMAIN_NOT_ALLOWED';

/** How long a confirmation link and code stay valid. */
const CONFIRMATION_TTL_SECONDS = 60 * 60;

/** How long a sign-in link stays valid: it is a credential on its own. */
const MAGIC_LINK_TTL_SECONDS = 15 * 60;

/**
 * Sign-in links per address: 5, refilling over a day. The route is
 * anonymous and sends mail; this limits what any number of clients can send
 * to one inbox, like onboarding's budget.
 */
const MAGIC_LINK_MAIL_BUDGET: RateLimitConfig = { burst: 5, perSecond: 5 / 86_400 };

/**
 * The email-OTP plugin's routes that stay off. It is here for one thing: the
 * code in the confirmation mail, typed at `/verify-email`. That code is only
 * ever sent with its link, from `sendVerificationEmail`, so every route that
 * *sends* a code is off — one resend path, not two. Sign-in by code (which
 * would also sign up, past the password), email change, and the password
 * codes are off too. What stays on: confirming by code. Every code is
 * hashed, an hour, three wrong guesses.
 */
const DISABLED_OTP_PATHS = [
  '/email-otp/send-verification-otp',
  '/sign-in/email-otp',
  '/email-otp/request-password-reset',
  '/forget-password/email-otp',
  '/email-otp/check-verification-otp',
  '/email-otp/reset-password',
  '/email-otp/request-email-change',
  '/email-otp/change-email',
];

/**
 * The API-key plugin's own routes, all off. Keys are minted, listed and
 * revoked only through `/api/v1/me/tokens` (`server/tokens.ts`, calling the
 * plugin server-side, which `disabledPaths` does not affect). Left on,
 * `/api-key/update` would let a session switch a revoked key back on, and
 * `/api-key/create` would mint keys past `/me/tokens`.
 */
const DISABLED_API_KEY_PATHS = [
  '/api-key/create',
  '/api-key/get',
  '/api-key/list',
  '/api-key/update',
  '/api-key/delete',
];

/**
 * Marks a sign-in link as onboarding's, for an address that already has an
 * account (`mailExistingAccount`). Random per process and never sent to a
 * client, so `/sign-in/magic-link`'s client-supplied `metadata` cannot forge it.
 */
const EXISTING_ACCOUNT = randomBytes(16).toString('hex');

/**
 * Onboarding with an address that already has a confirmed account: one mail
 * that says so, with a sign-in link and a code, both landing on
 * `/verify-email`. The answer to the request is the same as for a new
 * address; only the inbox learns. Over a mail budget nothing is sent and
 * the answer is unchanged: a 429 would tell anyone which addresses have
 * accounts.
 */
export async function mailExistingAccount(email: string, callbackURL: string): Promise<void> {
  try {
    await getAuth().api.signInMagicLink({
      body: { email, callbackURL, errorCallbackURL: callbackURL, metadata: { existingAccount: EXISTING_ACCOUNT } },
      headers: new Headers(),
    });
  } catch (err) {
    if (err instanceof APIError && err.statusCode === 429) return;
    throw err;
  }
}

/** Whether the user can sign in with a password yet. */
export async function hasPassword(userId: string, database: Database = getDb()): Promise<boolean> {
  const [row] = await database
    .select({ password: authSchema.account.password })
    .from(authSchema.account)
    .where(and(eq(authSchema.account.userId, userId), eq(authSchema.account.providerId, 'credential')));
  return !!row?.password;
}

/**
 * What a signed-in user still lacks: a name (an account made by a sign-in
 * link has none) and a password. `/verify-email` asks for these.
 */
export async function missingFromUser(
  userId: string,
  database: Database = getDb(),
): Promise<{ name: boolean; password: boolean }> {
  const [row] = await database
    .select({ name: authSchema.user.name })
    .from(authSchema.user)
    .where(eq(authSchema.user.id, userId));
  return { name: !row?.name.trim(), password: !(await hasPassword(userId, database)) };
}

/**
 * The address of the account a password-reset token is for, or `null` when
 * the token is unknown or expired. The token alone decides whose password
 * `/reset-password` sets, so `/set-password` names this account, never the
 * `?email=` in its URL. Read without consuming it.
 */
export async function resetTokenEmail(token: string, database: Database = getDb()): Promise<string | null> {
  const ctx = await getAuth().$context;
  const row = await ctx.internalAdapter.findVerificationValue(`reset-password:${token}`);
  if (!row || row.expiresAt < new Date()) return null;
  const [u] = await database
    .select({ email: authSchema.user.email })
    .from(authSchema.user)
    .where(eq(authSchema.user.id, row.value));
  return u?.email ?? null;
}

/**
 * Auth mail per address — confirmations, resets and onboarding's "already
 * registered" codes together: 10, refilling over a day. Every route that sends one is
 * anonymous, and Better Auth's own limiter is per IP; this caps what any
 * number of IPs can send one inbox, and how many fresh codes (3 guesses
 * each) anyone can have minted for it. `false` means send nothing.
 */
async function authMailBudget(email: string): Promise<boolean> {
  return (await consume(`auth-mail:${email.trim().toLowerCase()}`, AUTH_MAIL_BUDGET)).allowed;
}

const AUTH_MAIL_BUDGET: RateLimitConfig = { burst: 10, perSecond: 10 / 86_400 };

/**
 * Drop the passwords and sessions a user had before proving the address
 * (`afterEmailVerification`). Sign-up takes no password, so this
 * only finds one set by a sign-up from before that, or by someone else.
 */
async function revokeUnprovenAccess(userId: string, database: Database): Promise<void> {
  await database
    .delete(authSchema.account)
    .where(and(eq(authSchema.account.userId, userId), eq(authSchema.account.providerId, 'credential')));
  await database.delete(authSchema.session).where(eq(authSchema.session.userId, userId));
}

export function createAuth(database: Database) {
  const auth = betterAuth({
    appName: 'acceptodds',
    baseURL: baseURL(),
    secret: process.env.BETTER_AUTH_SECRET,
    trustedOrigins: [new URL(baseURL()).origin],
    database: drizzleAdapter(database, { provider: 'pg', schema: authSchema }),

    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      minPasswordLength: 12,
      // A reset proves the inbox, and ends every other session, so a reset
      // after a stolen session actually locks the thief out (the person is
      // signed in afresh by `/set-password`).
      revokeSessionsOnPasswordReset: true,
      // An account with no password yet (made by onboarding) is told so; either
      // way the link sets one (`/set-password`) and signs in.
      sendResetPassword: async ({ user, url }) => {
        // Silently, over budget: saying so would tell anyone which addresses
        // have accounts (Better Auth answers the same for an unknown one).
        if (!(await authMailBudget(user.email))) return;
        const first = !(await hasPassword(user.id, database));
        await sendMail({ to: user.email, ...passwordMail(first, url) });
      },
    },
    emailVerification: {
      // Signing in unconfirmed with the right password — only a user from
      // before sign-up stopped taking passwords can — sends a fresh code and
      // link. Confirming then drops that password (below), and
      // `/verify-email` asks for one.
      sendOnSignIn: true,
      autoSignInAfterVerification: true,
      expiresIn: CONFIRMATION_TTL_SECONDS,
      sendVerificationEmail: async ({ user, url }) => {
        // Silently over budget, as above: before a code is minted, so a
        // spent budget also stops handing out fresh guesses.
        if (!(await authMailBudget(user.email))) return;
        // Each mail rotates the code: only the newest one works.
        const code = await auth.api.createVerificationOTP({ body: { email: user.email, type: 'email-verification' } });
        await sendMail({ to: user.email, ...confirmationMail(code, url) });
      },
      // Confirmation is the institutional verification: it creates the trader
      // account, grants the starting balance and sets `verified_at`, once.
      // `server/auth.ts` repeats this lazily, so a failure here costs a retry.
      //
      // Before that it drops every password and session the user had before the
      // address was proven. Whoever set them may not be whoever owns the inbox:
      // otherwise someone could sign up with your address and their password,
      // and wait for you to confirm it. Better Auth does this itself for a
      // sign-in link, but not for confirmation. Runs before the confirmation's
      // own session is made, so that one survives.
      //
      // Only for an address not yet proven: the code in an existing account's
      // onboarding mail (`mailExistingAccount`) goes through here too, and
      // its password was set after its address was proven.
      beforeEmailVerification: async (user) => {
        if (!user.emailVerified) await revokeUnprovenAccess(user.id, database);
      },
      afterEmailVerification: async (user) => {
        await ensureAccountForUser({ id: user.id, name: user.name, email: user.email }, database);
      },
    },

    // The address can only be changed if this is turned on, and a new address
    // would bypass the allowlist check below. Keep it off.
    user: { changeEmail: { enabled: false } },

    databaseHooks: {
      user: {
        create: {
          // Refuse an unlisted domain before a user row exists or any mail is sent.
          // (Bots' login-less users are inserted directly and never pass here.)
          //
          // 422, not 403: Better Auth answers a 403 from user creation with a
          // fake success (its guard against email enumeration), which would
          // leave the person waiting for a mail that never comes. The domain
          // list is not a secret, so saying no plainly leaks nothing.
          before: async (user) => {
            if (!institutionForEmail(user.email)) {
              throw new APIError('UNPROCESSABLE_ENTITY', {
                code: EMAIL_DOMAIN_NOT_ALLOWED,
                message: 'sign-up is open to approved institutional email domains only, without a +tag',
              });
            }
          },
        },
      },
    },

    // Sign-up is ours (`server/onboarding.ts`): it takes no password, so
    // Better Auth's, which does, is off. So are the API-key routes (above).
    disabledPaths: ['/sign-up/email', ...DISABLED_OTP_PATHS, ...DISABLED_API_KEY_PATHS],

    advanced: {
      // Better Auth skips its origin/CSRF check when NODE_ENV=test. Pin it on,
      // so the tests exercise what production runs.
      disableOriginCheck: false,
      // The real client is Cf-Connecting-Ip; X-Forwarded-For (Better Auth's
      // default) is whatever the client sent. See `clientIp()`.
      ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] },
    },

    plugins: [
      // Sign in by a link in the mail, from `/signin`. An address with no
      // account gets one when the link is opened — confirmed, since the link
      // proves the inbox, with no name and no password, which
      // `/verify-email` then asks for. The allowlist is checked here,
      // before any mail, as well as in the `user.create.before` hook, so an
      // unlisted address is refused on the sign-in page, not by a dead link.
      // The answer is otherwise the same whether or not the address has an
      // account; only the inbox learns.
      magicLink({
        expiresIn: MAGIC_LINK_TTL_SECONDS,
        sendMagicLink: async ({ email, url, metadata }) => {
          const address = email.trim().toLowerCase();
          if (!institutionForEmail(address)) {
            throw new APIError('UNPROCESSABLE_ENTITY', {
              code: EMAIL_DOMAIN_NOT_ALLOWED,
              message: 'sign-in is open to approved institutional email domains only, without a +tag',
            });
          }
          const budget = await consume(`magic-link-mail:${address}`, MAGIC_LINK_MAIL_BUDGET);
          if (!budget.allowed) {
            throw new APIError('TOO_MANY_REQUESTS', {
              code: 'RATE_LIMITED',
              message: 'too many sign-in links to this address; try again later',
            });
          }
          if (metadata?.existingAccount === EXISTING_ACCOUNT && (await authMailBudget(address))) {
            // Onboarding with an address that has an account: say so, and add
            // a code for the page the person is on (`/verify-email`'s
            // `CodeForm`). For a confirmed address that code signs in.
            const code = await auth.api.createVerificationOTP({
              body: { email: address, type: 'email-verification' },
            });
            await sendMail({ to: address, ...existingAccountMail(code, url) });
            return;
          }
          await sendMail({ to: address, ...magicLinkMail(url) });
        },
      }),
      emailOTP({
        expiresIn: CONFIRMATION_TTL_SECONDS,
        storeOTP: 'hashed',
        disableSignUp: true,
        // Never called: every route that would send a code is disabled above.
        sendVerificationOTP: async () => {
          throw new Error('codes are sent only with the confirmation link');
        },
      }),
      apiKey({
        defaultPrefix: API_KEY_PREFIX,
        // §7: `pm_live_` + 32 random bytes. The plugin stores only its SHA-256.
        customKeyGenerator: ({ prefix }) => `${prefix ?? API_KEY_PREFIX}${randomBytes(32).toString('base64url')}`,
        startingCharactersConfig: { shouldStore: true, charactersLength: 16 },
        requireName: true,
        // One rate limiter, not two: the per-credential token bucket in
        // `server/ratelimit.ts` (§7) limits every authenticated request.
        rateLimit: { enabled: false },
      }),
    ],
  });
  return auth;
}

export type Auth = ReturnType<typeof createAuth>;

let cached: Auth | undefined;

/**
 * Lazy, like `getDb()`: `next build` imports every route module and must not
 * need a database or a secret.
 */
export function getAuth(): Auth {
  cached ??= createAuth(getDb());
  return cached;
}
