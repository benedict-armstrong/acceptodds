import { randomBytes } from 'node:crypto';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { genericOAuth, type GenericOAuthConfig } from 'better-auth/plugins/generic-oauth';
import { apiKey } from '@better-auth/api-key';
import { getDb, type Database } from '@/db';
import * as authSchema from '@/db/auth-schema';
import { CLIENT_IP_HEADER } from './api/http';
import { ensureAccountForUser, recordOrcid } from './accounts';
import { sendMail } from './mail';

/**
 * Better Auth, mounted in-app with its tables in our Postgres
 * (IMPLEMENTATION.md §8). It owns identity — users, sessions, linked OAuth
 * accounts, email verification and API keys. It does **not** own traders:
 * `accounts` is ours, one row per Better Auth `user`, created with its signup
 * grant the moment the user is (see `databaseHooks`).
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

function orcidProvider(): GenericOAuthConfig | null {
  const clientId = process.env.ORCID_CLIENT_ID;
  const clientSecret = process.env.ORCID_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  return {
    providerId: 'orcid',
    clientId,
    clientSecret,
    authorizationUrl: 'https://orcid.org/oauth/authorize',
    tokenUrl: 'https://orcid.org/oauth/token',
    userInfoUrl: 'https://orcid.org/oauth/userinfo',
    scopes: ['/authenticate', 'openid'],
    mapProfileToUser: mapOrcidProfile,
  };
}

/**
 * ORCID is identity, **not** verification: anyone can mint an iD in a minute
 * (§8). Its userinfo carries `sub` (the iD) and names, and usually no email —
 * ORCID only releases one the researcher made public. Better Auth needs an
 * email per user, so an iD without one gets an undeliverable placeholder under
 * the reserved `.invalid` TLD, marked unverified. It is never mailed.
 */
export function mapOrcidProfile(profile: Record<string, unknown>): {
  name: string;
  email: string;
  emailVerified: boolean;
} {
  const sub = String(profile.sub ?? profile.id ?? '');
  const given = typeof profile.given_name === 'string' ? profile.given_name : '';
  const family = typeof profile.family_name === 'string' ? profile.family_name : '';
  const name = (typeof profile.name === 'string' && profile.name) || `${given} ${family}`.trim() || sub;
  const email = typeof profile.email === 'string' && profile.email ? profile.email : `${sub}@orcid.invalid`;
  return { name, email, emailVerified: false };
}

function baseURL(): string {
  const url = process.env.BETTER_AUTH_URL ?? process.env.APP_URL;
  if (!url) throw new Error('BETTER_AUTH_URL is not set');
  return url;
}

export function createAuth(database: Database) {
  const orcid = orcidProvider();
  return betterAuth({
    appName: 'papermarket',
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
          subject: 'Reset your papermarket password',
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
          subject: 'Confirm your papermarket email',
          text: `Confirm this address to finish signing up:\n\n${url}`,
        });
      },
    },

    account: {
      // Signing in with ORCID and with a password that share a verified email
      // is one person.
      accountLinking: { enabled: true, trustedProviders: ['orcid'] },
    },

    databaseHooks: {
      user: {
        create: {
          // Every signed-up human gets a trader row and the starting balance,
          // as a `signup` ledger entry. `ensureAccountForUser` is idempotent,
          // and `server/auth.ts` calls it again lazily, so a failure here
          // costs a retry, not an orphaned user.
          after: async (user) => {
            await ensureAccountForUser({ id: user.id, name: user.name, email: user.email }, database);
          },
        },
      },
      account: {
        create: {
          after: async (linked) => {
            if (linked.providerId === 'orcid') await recordOrcid(linked.userId, linked.accountId, database);
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
      ...(orcid ? [genericOAuth({ config: [orcid] })] : []),
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
