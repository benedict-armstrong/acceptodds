import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';
import { getDb, type Database } from '@/db';
import { isUniqueViolation } from '@/db/errors';
import { apiTokens, type ApiToken, type TokenScope } from '@/db/schema';

/**
 * API tokens (IMPLEMENTATION.md §7).
 *
 * A token is `pm_live_` + 32 random bytes (base64url). It is shown **once**, at
 * minting, and never stored: the database holds its SHA-256 and a short
 * `prefix` to find the row by. Verification looks the row up by prefix and
 * compares hashes in constant time, so neither the lookup nor the compare
 * leaks how much of a guessed token was right.
 *
 * M5 is expected to put session cookies next to this, not in place of it: the
 * resolution of a request to an account lives in `server/auth.ts`, and nothing
 * outside it should call `verifyToken`.
 */

export const TOKEN_PREFIX = 'pm_live_';
export const TOKEN_SCOPES = ['read', 'trade', 'admin'] as const satisfies readonly TokenScope[];

/** `pm_live_` plus the first 8 characters of the secret: 48 bits to look up by. */
const LOOKUP_LENGTH = TOKEN_PREFIX.length + 8;
const TOKEN_PATTERN = /^pm_live_[A-Za-z0-9_-]{43}$/;

function sha256(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

export interface MintedToken {
  /** The secret. Returned here and nowhere else, ever. */
  token: string;
  row: ApiToken;
}

export async function mintToken(
  input: { accountId: string; name: string; scopes: TokenScope[] },
  database: Database = getDb(),
): Promise<MintedToken> {
  const scopes = [...new Set(input.scopes)];
  if (scopes.length === 0) throw new Error('a token needs at least one scope');

  // A prefix collision is a 1-in-2^48 event per pair; retry rather than reason about it.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const token = TOKEN_PREFIX + randomBytes(32).toString('base64url');
    try {
      const [row] = await database
        .insert(apiTokens)
        .values({
          accountId: input.accountId,
          prefix: token.slice(0, LOOKUP_LENGTH),
          tokenHash: sha256(token).toString('hex'),
          name: input.name,
          scopes,
        })
        .returning();
      return { token, row };
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
    }
  }
  throw new Error('could not mint a token with a unique prefix');
}

/**
 * The token's row, or `null` if it is malformed, unknown or revoked. Never
 * throws for a bad token: the caller turns `null` into a 401.
 */
export async function verifyToken(
  token: string,
  database: Database = getDb(),
): Promise<ApiToken | null> {
  if (!TOKEN_PATTERN.test(token)) return null;

  const [row] = await database
    .select()
    .from(apiTokens)
    .where(eq(apiTokens.prefix, token.slice(0, LOOKUP_LENGTH)));
  if (!row || row.revokedAt) return null;

  const stored = Buffer.from(row.tokenHash, 'hex');
  const presented = sha256(token);
  if (stored.length !== presented.length || !timingSafeEqual(stored, presented)) return null;

  // Bookkeeping, at most once a minute per token, and never allowed to fail
  // the request it is attached to.
  database
    .update(apiTokens)
    .set({ lastUsedAt: sql`now()` })
    .where(
      and(
        eq(apiTokens.id, row.id),
        or(isNull(apiTokens.lastUsedAt), lt(apiTokens.lastUsedAt, sql`now() - interval '1 minute'`)),
      ),
    )
    .catch(() => {});

  return row;
}

export async function revokeToken(tokenId: string, database: Database = getDb()): Promise<void> {
  await database
    .update(apiTokens)
    .set({ revokedAt: sql`now()` })
    .where(and(eq(apiTokens.id, tokenId), isNull(apiTokens.revokedAt)));
}
