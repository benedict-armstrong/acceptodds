import { and, desc, eq, gt, inArray, sql } from 'drizzle-orm';
import { getDb, type Database } from '@/db';
import { accounts, comments, outcomes, positions } from '@/db/schema';
import { ApiError } from './api/errors';
import { encodeCursor } from './views';

/**
 * Market discussion, Polymarket-style: every comment shows the author's
 * **current stake in that market** and whether they are a bot, and nothing
 * else about them — no handle, no account id, no institution.
 *
 * The stake is read at display time from `positions`, so it moves as the
 * author trades and is empty once a market settles (settlement zeroes every
 * position). That is deliberate: it answers "what does this person hold
 * now", which is what a reader weighs a comment by.
 *
 * Not market state, so not the engine's: this module writes `comments` only.
 */

export const MAX_COMMENT_LENGTH = 2000;

export interface CommentView {
  id: string;
  body: string;
  createdAt: Date;
  author: {
    isBot: boolean;
    /** True when the viewer wrote it. Lets a client say "you" without revealing anyone else. */
    isYou: boolean;
    stake: { outcomeId: string; outcomeLabel: string; sharesMicro: bigint }[];
  };
}

export async function postComment(
  input: { marketId: string; accountId: string; body: string },
  database: Database = getDb(),
): Promise<{ id: string; createdAt: Date }> {
  const body = input.body.trim();
  if (body.length === 0 || body.length > MAX_COMMENT_LENGTH) {
    throw new ApiError(400, 'validation_error', `a comment is 1–${MAX_COMMENT_LENGTH} characters`);
  }
  const [row] = await database
    .insert(comments)
    .values({ marketId: input.marketId, accountId: input.accountId, body })
    .returning({ id: comments.id, createdAt: comments.createdAt });
  return row;
}

const PG_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function decodeCursor(cursor: string | undefined): { t: string; id: string } | null {
  if (cursor === undefined) return null;
  try {
    const key = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (PG_TS.test(key?.t) && UUID.test(key?.id)) return { t: key.t, id: key.id };
  } catch {
    /* fall through */
  }
  throw new ApiError(400, 'validation_error', 'invalid cursor');
}

/** Newest first, keyset-paginated like every other list. */
export async function listComments(
  marketId: string,
  q: { cursor?: string; limit: number; viewerAccountId?: string | null },
  database: Database = getDb(),
): Promise<{ comments: CommentView[]; nextCursor: string | null }> {
  const before = decodeCursor(q.cursor);
  const rows = await database
    .select({
      id: comments.id,
      body: comments.body,
      createdAt: comments.createdAt,
      ts: sql<string>`to_char(${comments.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
      accountId: comments.accountId,
      isBot: accounts.isBot,
    })
    .from(comments)
    .innerJoin(accounts, eq(accounts.id, comments.accountId))
    .where(
      and(
        eq(comments.marketId, marketId),
        before
          ? sql`(${comments.createdAt}, ${comments.id}) < (${before.t}::timestamptz, ${before.id}::uuid)`
          : undefined,
      ),
    )
    .orderBy(desc(comments.createdAt), desc(comments.id))
    .limit(q.limit + 1);

  const page = rows.slice(0, q.limit);
  const authorIds = [...new Set(page.map((r) => r.accountId))];

  const stakes = authorIds.length
    ? await database
        .select({
          accountId: positions.accountId,
          outcomeId: outcomes.id,
          outcomeLabel: outcomes.label,
          ordinal: outcomes.ordinal,
          sharesMicro: positions.sharesMicro,
        })
        .from(positions)
        .innerJoin(outcomes, eq(outcomes.id, positions.outcomeId))
        .where(
          and(
            eq(outcomes.marketId, marketId),
            inArray(positions.accountId, authorIds),
            gt(positions.sharesMicro, 0n),
          ),
        )
        .orderBy(outcomes.ordinal)
    : [];

  const last = page[page.length - 1];
  return {
    comments: page.map((r) => ({
      id: r.id,
      body: r.body,
      createdAt: r.createdAt,
      author: {
        isBot: r.isBot,
        isYou: q.viewerAccountId === r.accountId,
        stake: stakes
          .filter((s) => s.accountId === r.accountId)
          .map((s) => ({ outcomeId: s.outcomeId, outcomeLabel: s.outcomeLabel, sharesMicro: s.sharesMicro })),
      },
    })),
    nextCursor: rows.length > q.limit && last ? encodeCursor({ t: last.ts, id: last.id }) : null,
  };
}
