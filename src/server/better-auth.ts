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
import { setPasswordPath } from '@/lib/links';
import { sendMail } from './mail';
import { siteUrl } from './share';

/**
 * Better Auth, mounted in-app with its tables in our Postgres
 * (IMPLEMENTATION.md §8). It owns identity — users, sessions, email
 * verification and API keys. It does **not** own traders: `accounts` is ours,
 * one row per Better Auth `user`.
 *
 * Sign-up is email + password, and only from an address whose domain is on
 * the institution allowlist (`server/institution-domains.ts`). The trader
 * account — and with it the starting balance — is created only when that
 * address is **confirmed**, which is also what marks the account verified.
 * One mail confirms it two ways: a link, and a 6-digit code typed into
 * `/confirm` in the tab the person signed up in (issue #15), so they are never
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
 * The email-OTP plugin's routes that stay off. It is here for the codes in
 * two mails: the confirmation mail, and the "choose a password" mail to an
 * account that has none (`sendResetPassword`). Both are only ever sent with
 * their link, from those two callbacks, so every route that *sends* a code
 * is off — there is one resend path per mail, not two. Sign-in by code
 * (which would also sign up, past the password) and email change are off
 * too. What stays on: confirming by code, checking a password code (to go
 * on to `/set-password` with it) and setting the password with it. Every
 * code is hashed, an hour, three wrong guesses.
 */
const DISABLED_OTP_PATHS = [
  '/email-otp/send-verification-otp',
  '/sign-in/email-otp',
  '/email-otp/request-password-reset',
  '/forget-password/email-otp',
  '/email-otp/request-email-change',
  '/email-otp/change-email',
];

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
 * link has none) and a password. `/signin/continue` asks for these.
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
 * Auth mail per address — confirmations, resets and "already registered"
 * notes together: 10, refilling over a day. Every route that sends one is
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
 * (`afterEmailVerification`). Sign-up no longer takes a password, so this
 * only finds one set by a sign-up from before that, or by someone else.
 */
async function revokeUnprovenAccess(userId: string, database: Database): Promise<void> {
  await database
    .delete(authSchema.account)
    .where(and(eq(authSchema.account.userId, userId), eq(authSchema.account.providerId, 'credential')));
  await database.delete(authSchema.session).where(eq(authSchema.session.userId, userId));
}

type RequestReset = (body: { email: string; redirectTo: string }) => Promise<unknown>;

/**
 * To an address that already has a confirmed account and was just used to
 * sign up again: only the inbox's owner learns it is taken. An account made
 * by onboarding may have no password yet, and a link to `/signin` would be
 * no use to it: it gets a password-reset link instead, which sets its first
 * password and signs it in (`sendResetPassword`, `app/set-password`).
 */
export async function mailAlreadyRegistered(email: string, database: Database = getDb()): Promise<void> {
  await mailRegistered(email, database, (body) => getAuth().api.requestPasswordReset({ body }));
}

async function mailRegistered(email: string, database: Database, requestReset: RequestReset): Promise<void> {
  const [row] = await database
    .select({ id: authSchema.user.id })
    .from(authSchema.user)
    .where(eq(authSchema.user.email, email));
  if (row && !(await hasPassword(row.id, database))) {
    await requestReset({ email, redirectTo: setPasswordPath(email) });
    return;
  }
  if (!(await authMailBudget(email))) return;
  await sendMail({
    to: email,
    subject: 'You already have an acceptodds account',
    text:
      `Someone tried to sign up with this address, which already has an account. If it was you, sign in instead:\n\n` +
      `${siteUrl()}/signin\n\nIf not, ignore this; nothing has changed.`,
  });
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
      // An account with no password yet (made by onboarding) is told so, and
      // gets a code as well as the link: it may be on a page asking for one
      // (`/welcome`'s last step), where the code leads to `/set-password`
      // too. Each mail rotates the code. Either way it sets the first password.
      sendResetPassword: async ({ user, url }) => {
        // Silently, over budget: saying so would tell anyone which addresses
        // have accounts (Better Auth answers the same for an unknown one).
        if (!(await authMailBudget(user.email))) return;
        if (await hasPassword(user.id, database)) {
          await sendMail({
            to: user.email,
            subject: 'Reset your acceptodds password',
            text: `Someone asked to reset the password for this address. If it was you:\n\n${url}\n\nIf not, ignore this.`,
          });
          return;
        }
        const code = await auth.api.createVerificationOTP({ body: { email: user.email, type: 'forget-password' } });
        await sendMail({
          to: user.email,
          subject: `${code} is your acceptodds sign-in code`,
          text:
            `You already have an acceptodds account, but no password yet. Enter the code ${code} where you were asked ` +
            `for one, or open this link, to choose a password and sign in:\n\n${url}\n\n` +
            `Each works once, for an hour. If you did not ask for this, ignore it; nothing has changed.`,
        });
      },
    },
    emailVerification: {
      // Signing in unconfirmed with the right password — only a user from
      // before sign-up stopped taking passwords can — sends a fresh code and
      // link. Confirming then drops that password (below), and
      // `/signin/continue` asks for one.
      sendOnSignIn: true,
      autoSignInAfterVerification: true,
      expiresIn: CONFIRMATION_TTL_SECONDS,
      sendVerificationEmail: async ({ user, url }) => {
        // Silently over budget, as above: before a code is minted, so a
        // spent budget also stops handing out fresh guesses.
        if (!(await authMailBudget(user.email))) return;
        // Each mail rotates the code: only the newest one works.
        const code = await auth.api.createVerificationOTP({ body: { email: user.email, type: 'email-verification' } });
        await sendMail({
          to: user.email,
          subject: `${code} is your acceptodds confirmation code`,
          text:
            `Your confirmation code is ${code}. Enter it on the page you signed up on, or open this link:\n\n${url}\n\n` +
            `Both work for an hour. If you did not sign up, ignore this.`,
        });
      },
      // Confirmation is the institutional verification: it creates the trader
      // account, grants the starting balance and sets `verified_at`, once.
      // `server/auth.ts` repeats this lazily, so a failure here costs a retry.
      //
      // First it drops every password and session the user had before the
      // address was proven. Whoever set them may not be whoever owns the inbox:
      // otherwise someone could sign up with your address and their password,
      // and wait for you to confirm it. Better Auth does this itself for a
      // sign-in link, but not for confirmation. Runs before the confirmation's
      // own session is made, so that one survives.
      afterEmailVerification: async (user) => {
        await revokeUnprovenAccess(user.id, database);
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
                message: 'sign-up is open to approved institutional email domains only',
              });
            }
          },
        },
      },
    },

    // Sign-up is ours (`server/signup.ts`, `POST /signup`): it takes no
    // password, so Better Auth's, which does, is off.
    disabledPaths: ['/sign-up/email', ...DISABLED_OTP_PATHS],

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
      // `/signin/continue` then asks for. The allowlist is checked here,
      // before any mail, as well as in the `user.create.before` hook, so an
      // unlisted address is refused on the sign-in page, not by a dead link.
      // The answer is otherwise the same whether or not the address has an
      // account; only the inbox learns.
      magicLink({
        expiresIn: MAGIC_LINK_TTL_SECONDS,
        sendMagicLink: async ({ email, url }) => {
          const address = email.trim().toLowerCase();
          if (!institutionForEmail(address)) {
            throw new APIError('UNPROCESSABLE_ENTITY', {
              code: EMAIL_DOMAIN_NOT_ALLOWED,
              message: 'sign-in is open to approved institutional email domains only',
            });
          }
          const budget = await consume(`magic-link-mail:${address}`, MAGIC_LINK_MAIL_BUDGET);
          if (!budget.allowed) {
            throw new APIError('TOO_MANY_REQUESTS', {
              code: 'RATE_LIMITED',
              message: 'too many sign-in links to this address; try again later',
            });
          }
          await sendMail({
            to: address,
            subject: 'Your acceptodds sign-in link',
            text:
              `Open this link to sign in to acceptodds. If you have no account yet, it makes one:\n\n${url}\n\n` +
              `It works once, for 15 minutes. If you did not ask for it, ignore this; nothing has changed.`,
          });
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
