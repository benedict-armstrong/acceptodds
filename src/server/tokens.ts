import { randomUUID } from 'node:crypto';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { getDb } from '@/db';
import { apikey, user } from '@/db/auth-schema';
import { accounts, TOKEN_SCOPES, type Account, type TokenScope } from '@/db/schema';
import { API_KEY_PREFIX, API_KEY_RESOURCE, getAuth } from './better-auth';

/**
 * API tokens, on Better Auth's `apiKey` plugin (IMPLEMENTATION.md §7, §8).
 *
 * A token is `pm_live_` + 32 random bytes (base64url), shown **once**, at
 * minting. The plugin stores its SHA-256 and looks a presented token up by
 * that hash, so there is nothing to compare byte-by-byte and nothing to leak
 * through timing. Scopes are stored as the plugin's permissions,
 * `{ api: ['read', 'trade'] }`.
 *
 * The plugin keys every token on a Better Auth `user`. Humans have one; a bot
 * gets a **login-less** user the first time it is issued a token — a row with
 * an undeliverable `.invalid` email and no credential, so nothing can sign in
 * as it.
 *
 * Nothing outside `server/auth.ts` should call `verifyToken`.
 */

export { TOKEN_SCOPES };

const TOKEN_PATTERN = /^pm_live_[A-Za-z0-9_-]{43}$/;

export interface TokenRecord {
  id: string;
  name: string | null;
  /** The first 16 characters, `pm_live_` included: enough to recognise, useless to use. */
  start: string | null;
  scopes: TokenScope[];
  createdAt: Date;
  lastUsedAt: Date | null;
  enabled: boolean;
}

function scopesOf(permissions: unknown): TokenScope[] {
  const parsed = typeof permissions === 'string' ? safeParse(permissions) : permissions;
  const list = (parsed as Record<string, unknown> | null)?.[API_KEY_RESOURCE];
  return Array.isArray(list) ? TOKEN_SCOPES.filter((s) => list.includes(s)) : [];
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/** The Better Auth user a token for this account is issued to, creating a login-less one for a bot. */
async function userIdFor(account: Account): Promise<string> {
  if (account.userId) return account.userId;
  if (account.isHouse) throw new Error('house accounts do not get tokens');
  if (!account.isBot) {
    throw new Error(`account ${account.handle} has no user to issue a token to (humans get one by signing up)`);
  }

  const db = getDb();
  const id = randomUUID();
  await db.insert(user).values({
    id,
    name: account.displayName,
    email: `${account.handle}@bots.papermarket.invalid`,
    emailVerified: false,
  });
  // Only claim the account if nobody else did in the meantime.
  const [claimed] = await db
    .update(accounts)
    .set({ userId: id })
    .where(and(eq(accounts.id, account.id), isNull(accounts.userId)))
    .returning();
  if (claimed) return id;

  // Lost a race with another mint: use the winner's user, drop ours.
  await db.delete(user).where(eq(user.id, id));
  const [current] = await db.select().from(accounts).where(eq(accounts.id, account.id));
  return current.userId!;
}

export interface MintedToken {
  /** The secret. Returned here and nowhere else, ever. */
  token: string;
  record: TokenRecord;
}

export async function mintToken(input: { account: Account; name: string; scopes: TokenScope[] }): Promise<MintedToken> {
  const scopes = TOKEN_SCOPES.filter((s) => input.scopes.includes(s));
  if (scopes.length === 0) throw new Error('a token needs at least one scope');
  const userId = await userIdFor(input.account);

  const created = await getAuth().api.createApiKey({
    body: { userId, name: input.name, permissions: { [API_KEY_RESOURCE]: scopes } },
  });
  return {
    token: created.key,
    record: {
      id: created.id,
      name: created.name,
      start: created.start,
      scopes,
      createdAt: new Date(created.createdAt),
      lastUsedAt: null,
      enabled: true,
    },
  };
}

export interface VerifiedToken {
  id: string;
  userId: string;
  scopes: TokenScope[];
}

/**
 * The token's owner and scopes, or `null` if it is malformed, unknown,
 * disabled or expired. Never throws for a bad token: the caller turns `null`
 * into a 401.
 */
export async function verifyToken(token: string): Promise<VerifiedToken | null> {
  if (!TOKEN_PATTERN.test(token)) return null;
  const result = await getAuth().api.verifyApiKey({ body: { key: token } });
  if (!result.valid || !result.key) return null;
  return { id: result.key.id, userId: result.key.referenceId, scopes: scopesOf(result.key.permissions) };
}

export async function listTokens(userId: string): Promise<TokenRecord[]> {
  const rows = await getDb()
    .select()
    .from(apikey)
    .where(eq(apikey.referenceId, userId))
    .orderBy(desc(apikey.createdAt));
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    start: r.start,
    scopes: scopesOf(r.permissions),
    createdAt: r.createdAt,
    lastUsedAt: r.lastRequest,
    enabled: r.enabled !== false,
  }));
}

/** Revoke (disable) a token. `false` if the user has no such token. */
export async function revokeToken(userId: string, tokenId: string): Promise<boolean> {
  const updated = await getDb()
    .update(apikey)
    .set({ enabled: false, updatedAt: new Date() })
    .where(and(eq(apikey.id, tokenId), eq(apikey.referenceId, userId)))
    .returning({ id: apikey.id });
  return updated.length > 0;
}

export { API_KEY_PREFIX };
