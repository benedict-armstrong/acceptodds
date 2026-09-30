import { randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { betterAuth } from 'better-auth';
import { APIError } from 'better-auth/api';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { emailOTP } from 'better-auth/plugins/email-otp';
import { apiKey } from '@better-auth/api-key';
import { getDb, type Database } from '@/db';
import * as authSchema from '@/db/auth-schema';
import { CLIENT_IP_HEADER } from './api/http';
import { ensureAccountForUser } from './accounts';
import { institutionForEmail } from './institution-domains';
import { setPasswordPath } from '@/lib/links';
import { safeReturnTo } from '@/lib/return-to';
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
  const [row] = await database.select({ id: authSchema.user.id }).from(authSchema.user).where(eq(authSchema.user.email, email));
  if (row && !(await hasPassword(row.id, database))) {
    await requestReset({ email, redirectTo: setPasswordPath(email) });
    return;
  }
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
      // With verification required, signing up with a taken address answers
      // exactly like a fresh sign-up (Better Auth's guard against email
      // enumeration) and creates nothing. The person is on `/confirm` waiting
      // for a code, so mail the address rather than leave them there: a fresh
      // code and link if it was never confirmed, else a note to sign in. Only
      // the inbox's owner learns the address is taken, and the password typed
      // here is ignored.
      onExistingUserSignUp: async ({ user }, request) => {
        if (!user.emailVerified) {
          const body = (await request?.json().catch(() => null)) as { callbackURL?: unknown } | null;
          const callbackURL = typeof body?.callbackURL === 'string' ? safeReturnTo(body.callbackURL) : undefined;
          await auth.api.sendVerificationEmail({ body: { email: user.email, callbackURL } });
          return;
        }
        await mailRegistered(user.email, database, (body) => auth.api.requestPasswordReset({ body }));
      },
      // An account with no password yet (made by onboarding) is told so, and
      // gets a code as well as the link: it may be on a page asking for one
      // (`/welcome`'s last step), where the code leads to `/set-password`
      // too. Each mail rotates the code. Either way it sets the first password.
      sendResetPassword: async ({ user, url }) => {
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
      sendOnSignUp: true,
      // Signing in unconfirmed (right password only) sends a fresh code + link.
      sendOnSignIn: true,
      autoSignInAfterVerification: true,
      expiresIn: CONFIRMATION_TTL_SECONDS,
      sendVerificationEmail: async ({ user, url }) => {
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
                message: 'sign-up is open to approved institutional email domains only',
              });
            }
          },
        },
      },
    },

    disabledPaths: DISABLED_OTP_PATHS,

    advanced: {
      // Better Auth skips its origin/CSRF check when NODE_ENV=test. Pin it on,
      // so the tests exercise what production runs.
      disableOriginCheck: false,
      // The real client is Cf-Connecting-Ip; X-Forwarded-For (Better Auth's
      // default) is whatever the client sent. See `clientIp()`.
      ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] },
    },

    plugins: [
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
