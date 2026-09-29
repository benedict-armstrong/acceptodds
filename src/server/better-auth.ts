import { randomBytes } from 'node:crypto';
import { betterAuth } from 'better-auth';
import { APIError } from 'better-auth/api';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { apiKey } from '@better-auth/api-key';
import { getDb, type Database } from '@/db';
import * as authSchema from '@/db/auth-schema';
import { CLIENT_IP_HEADER } from './api/http';
import { ensureAccountForUser } from './accounts';
import { institutionForEmail } from './institution-domains';
import { sendMail } from './mail';

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

export function createAuth(database: Database) {
  return betterAuth({
    appName: 'acceptodds',
    baseURL: baseURL(),
    secret: process.env.BETTER_AUTH_SECRET,
    trustedOrigins: [new URL(baseURL()).origin],
    database: drizzleAdapter(database, { provider: 'pg', schema: authSchema }),

    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      minPasswordLength: 12,
      sendResetPassword: async ({ user, url }) => {
        await sendMail({
          to: user.email,
          subject: 'Reset your acceptodds password',
          text: `Someone asked to reset the password for this address. If it was you:\n\n${url}\n\nIf not, ignore this.`,
        });
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: true,
      sendVerificationEmail: async ({ user, url }) => {
        await sendMail({
          to: user.email,
          subject: 'Confirm your acceptodds email',
          text: `Confirm this address to finish signing up:\n\n${url}`,
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

    advanced: {
      // Better Auth skips its origin/CSRF check when NODE_ENV=test. Pin it on,
      // so the tests exercise what production runs.
      disableOriginCheck: false,
      // The real client is Cf-Connecting-Ip; X-Forwarded-For (Better Auth's
      // default) is whatever the client sent. See `clientIp()`.
      ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] },
    },

    plugins: [
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
