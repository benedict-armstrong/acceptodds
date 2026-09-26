import { eq } from 'drizzle-orm';
import { getDb, type Database } from '@/db';
import { accounts, type Account, type TokenScope } from '@/db/schema';
import { ApiError } from './api/errors';
import { consume, rateLimitHeaders, type RateLimitResult } from './ratelimit';
import { verifyToken } from './tokens';

/**
 * Resolve a request to an account. **The only place that does.**
 *
 * Today the only credential is a bearer token (`Authorization: Bearer
 * pm_live_…`). M5 adds Better Auth session cookies; it should do so by adding
 * a branch to `authenticate()` that returns a `Principal` with
 * `method: 'session'`, and no route handler should need to change. Routes ask
 * for a principal and a scope; they never read `Authorization` or a cookie.
 */

export type AuthMethod = 'token' | 'session';

export interface Principal {
  account: Account;
  method: AuthMethod;
  /**
   * What this credential may do. A token carries its own scopes; a session
   * (M5) will carry whatever a signed-in human may do.
   */
  scopes: readonly TokenScope[];
  tokenId: string | null;
  /** Set when this request was counted against a rate-limit bucket. */
  rateLimit: RateLimitResult | null;
}

function bearer(req: Request): string | null | undefined {
  const header = req.headers.get('authorization');
  if (header === null) return undefined;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return match ? match[1] : null;
}

/**
 * `null` when the request carries no credentials at all. A credential that is
 * present but wrong is a 401, never a silent downgrade to anonymous: a bot with
 * a revoked token should find out on its first read, not on its first trade.
 *
 * Every authenticated request is counted against its credential's bucket, and
 * a request over the limit is refused here with `429 rate_limited`.
 */
export async function authenticate(
  req: Request,
  database: Database = getDb(),
): Promise<Principal | null> {
  const token = bearer(req);
  if (token === undefined) return null;
  if (token === null) {
    throw new ApiError(401, 'unauthorized', 'Authorization must be "Bearer <token>"', undefined, {
      'WWW-Authenticate': 'Bearer',
    });
  }

  const row = await verifyToken(token, database);
  if (!row) {
    throw new ApiError(401, 'unauthorized', 'invalid or revoked token', undefined, {
      'WWW-Authenticate': 'Bearer error="invalid_token"',
    });
  }

  const [account] = await database.select().from(accounts).where(eq(accounts.id, row.accountId));
  if (!account) {
    throw new ApiError(401, 'unauthorized', 'token has no account');
  }

  const rateLimit = await consume(`token:${row.id}`);
  if (!rateLimit.allowed) {
    throw new ApiError(
      429,
      'rate_limited',
      'too many requests for this token',
      { retryAfterSeconds: rateLimit.retryAfterSeconds },
      rateLimitHeaders(rateLimit),
    );
  }

  return { account, method: 'token', scopes: row.scopes, tokenId: row.id, rateLimit };
}

/** A principal holding `scope`, or a 401/403. */
export async function requireAuth(
  req: Request,
  scope: TokenScope,
  database: Database = getDb(),
): Promise<Principal> {
  const principal = await authenticate(req, database);
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
export async function requireSession(
  req: Request,
  database: Database = getDb(),
): Promise<Principal> {
  const principal = await authenticate(req, database);
  if (!principal) {
    throw new ApiError(401, 'unauthorized', 'sign in required');
  }
  if (principal.method !== 'session') {
    throw new ApiError(403, 'session_required', 'this endpoint accepts a signed-in session only, never an API token');
  }
  return principal;
}
