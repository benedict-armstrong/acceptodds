import { cache } from 'react';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { accounts, type Account, type TokenScope } from '@/db/schema';
import { ApiError } from './api/errors';
import { ensureAccountForUser } from './accounts';
import { getAuth } from './better-auth';
import { consume, rateLimitConfig, rateLimitHeaders, type RateLimitResult } from './ratelimit';
import { verifyToken } from './tokens';

/**
 * Resolve a request to an account. **The only place that does.**
 *
 * Two credentials, both resolving to one trader row:
 *
 *  - `Authorization: Bearer pm_live_…` — an API key (Better Auth's `apiKey`
 *    plugin), carrying its own scopes;
 *  - the Better Auth session cookie — a signed-in human, who may `read` and
 *    `trade` (trading is further gated on institutional verification, below),
 *    and `admin` only if their email is in `ADMIN_EMAILS`.
 *
 * A bearer token wins if both are sent. Routes ask for a principal and a
 * scope; they never read `Authorization` or a cookie themselves.
 */

export type AuthMethod = 'token' | 'session';

export interface Principal {
  account: Account;
  method: AuthMethod;
  /** What this credential may do. */
  scopes: readonly TokenScope[];
  /** The API key's id, or the session's. */
  credentialId: string;
  /** Set when this request was counted against a rate-limit bucket. */
  rateLimit: RateLimitResult | null;
}

export const SESSION_SCOPES: readonly TokenScope[] = ['read', 'trade'];

/**
 * Human admins, deliberately the simplest thing that works: a signed-in user
 * whose (confirmed) email is in `ADMIN_EMAILS`, comma-separated, also gets the
 * `admin` scope. Change the list and restart; there is no admin UI for it.
 */
export function isAdminEmail(email: string): boolean {
  const list = (process.env.ADMIN_EMAILS ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return list.includes(email.trim().toLowerCase());
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function bearer(req: Request): string | null | undefined {
  const header = req.headers.get('authorization');
  if (header === null) return undefined;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return match ? match[1] : null;
}

async function limit(key: string, scopes: readonly TokenScope[]): Promise<RateLimitResult> {
  const rateLimit = await consume(key, rateLimitConfig(scopes.includes('admin')));
  if (!rateLimit.allowed) {
    throw new ApiError(
      429,
      'rate_limited',
      'too many requests for this credential',
      { retryAfterSeconds: rateLimit.retryAfterSeconds },
      rateLimitHeaders(rateLimit),
    );
  }
  return rateLimit;
}

/**
 * A cookie rides along on any request the browser makes, including one a
 * hostile page triggers. So a state-changing request authenticated by cookie
 * must come from our own origin. (Better Auth's cookies are `SameSite=Lax`,
 * which already stops a cross-site POST carrying them; this is the second
 * lock, and it does not depend on the browser.)
 */
function assertSameOrigin(req: Request): void {
  if (SAFE_METHODS.has(req.method)) return;
  const origin = req.headers.get('origin');
  const expected = new URL(process.env.BETTER_AUTH_URL ?? process.env.APP_URL ?? req.url).origin;
  if (origin !== expected) {
    throw new ApiError(403, 'forbidden', 'cross-origin request refused for a session-authenticated write');
  }
}

/**
 * `null` when the request carries no credentials at all. A credential that is
 * present but wrong is a 401, never a silent downgrade to anonymous: a bot with
 * a revoked token should find out on its first read, not on its first trade.
 *
 * Every authenticated request is counted against its credential's bucket, and
 * a request over the limit is refused here with `429 rate_limited`.
 */
export async function authenticate(req: Request): Promise<Principal | null> {
  const token = bearer(req);
  if (token !== undefined) return authenticateToken(token);
  if (req.headers.get('cookie')) return authenticateSession(req);
  return null;
}

async function authenticateToken(token: string | null): Promise<Principal> {
  if (token === null) {
    throw new ApiError(401, 'unauthorized', 'Authorization must be "Bearer <token>"', undefined, {
      'WWW-Authenticate': 'Bearer',
    });
  }
  const verified = await verifyToken(token);
  if (!verified) {
    throw new ApiError(401, 'unauthorized', 'invalid or revoked token', undefined, {
      'WWW-Authenticate': 'Bearer error="invalid_token"',
    });
  }
  const [account] = await getDb().select().from(accounts).where(eq(accounts.userId, verified.userId));
  if (!account) throw new ApiError(401, 'unauthorized', 'token has no account');

  const rateLimit = await limit(`apikey:${verified.id}`, verified.scopes);
  return { account, method: 'token', scopes: verified.scopes, credentialId: verified.id, rateLimit };
}

async function authenticateSession(req: Request): Promise<Principal | null> {
  const session = await getAuth().api.getSession({ headers: req.headers });
  if (!session) return null;
  // Better Auth refuses sign-in before confirmation; this makes sure an
  // unconfirmed user can never reach the account (and grant) below either.
  if (!session.user.emailVerified) return null;
  assertSameOrigin(req);

  // Normally created on email confirmation; this makes a missed hook harmless.
  const account = await ensureAccountForUser(session.user);
  const scopes: readonly TokenScope[] = isAdminEmail(session.user.email)
    ? [...SESSION_SCOPES, 'admin']
    : SESSION_SCOPES;
  const rateLimit = await limit(`user:${session.user.id}`, scopes);
  return { account, method: 'session', scopes, credentialId: session.session.id, rateLimit };
}

/** A principal holding `scope`, or a 401/403. */
export async function requireAuth(req: Request, scope: TokenScope): Promise<Principal> {
  const principal = await authenticate(req);
  if (!principal) {
    throw new ApiError(401, 'unauthorized', 'authentication required', undefined, {
      'WWW-Authenticate': 'Bearer',
    });
  }
  requireScope(principal, scope);
  return principal;
}

export function requireScope(principal: Principal, scope: TokenScope): void {
  if (!principal.scopes.includes(scope)) {
    throw new ApiError(403, 'forbidden', `this credential lacks the "${scope}" scope`, {
      requiredScope: scope,
      scopes: [...principal.scopes],
    });
  }
}

/**
 * For endpoints that must never be reachable with a bearer token — minting a
 * token with a token would let a leaked token outlive its revocation.
 */
export async function requireSession(req: Request): Promise<Principal> {
  if (bearer(req) !== undefined) {
    throw new ApiError(403, 'session_required', 'this endpoint accepts a signed-in session only, never an API token');
  }
  const principal = await authenticate(req);
  if (!principal) throw new ApiError(401, 'unauthorized', 'sign in required');
  return principal;
}

/**
 * **Trading is gated on `verified_at`, not on login** (§8). Anyone signed in
 * may browse and quote; only an account whose institutional address has been
 * confirmed may place an order. Bots are created by an operator, are exempt,
 * and are flagged `is_bot` everywhere a human sees them.
 *
 * This gate is at the API layer, not in `engine.trade()`: the engine takes an
 * account id and trusts its caller about who that is. M6's Server Actions must
 * call this too.
 */
export function requireTradingEligibility(principal: Principal): void {
  const a = principal.account;
  if (a.isBot || a.verifiedAt) return;
  throw new ApiError(403, 'not_verified', 'confirm an institutional email address before trading');
}

/** A page's signed-in viewer. `needsName`: no name yet (an account made by a sign-in link), so the layout asks for one. */
export interface Viewer {
  account: Account;
  isAdmin: boolean;
  email: string;
  needsName: boolean;
}

/**
 * The signed-in viewer of a server-rendered page, or `null`. For Server
 * Components only: read-only, so it neither counts against the rate limit nor
 * checks Origin. Anything that writes goes through the API (or through
 * `authenticate()`), never through this.
 */
export async function viewerFromHeaders(headers: Headers): Promise<Viewer | null> {
  const cookie = headers.get('cookie');
  if (!cookie) return null;
  return viewerForCookie(cookie);
}

const viewerForCookie = cache(async (cookie: string): Promise<Viewer | null> => {
  const session = await getAuth().api.getSession({ headers: new Headers({ cookie }) });
  if (!session || !session.user.emailVerified) return null;
  const account = await ensureAccountForUser(session.user);
  return {
    account,
    isAdmin: isAdminEmail(session.user.email),
    email: session.user.email,
    needsName: !session.user.name.trim(),
  };
});
