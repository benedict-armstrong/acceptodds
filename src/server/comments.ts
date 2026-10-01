import { and, asc, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { getDb, type Database } from '@/db';
import { accounts, commentBackings, comments, markets, outcomes, positions, type Market } from '@/db/schema';
import { prices } from '@/lib/lmsr';
import { costToMicro, microToFloat } from '@/lib/money';
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
 * Each comment also carries its **backing**: shares other traders have put
 * behind it (`server/backings.ts`), marked at the current price. That is a
 * relevance weight, **not a sale price** (§1.1) — nobody can sell a backing,
 * and the shares behind it would fetch less than their mark. Once the market
 * settles the mark is exact: 1 per share of the winner, 0 otherwise. A void
 * market's backings are worth 0. Backers are never identified; the reader gets
 * a count, and the viewer their own share.
 *
 * **Replies nest.** A reply names the comment it answers, at any depth. A
 * discussion is never read whole: the top level pages on its own (newest
 * first, or by backing), and comes with a preview of each tree — the first
 * {@link REPLY_PREVIEW} replies to each comment, {@link LIST_DEPTH} levels
 * down. `listReplies` pages the rest of any comment's replies, oldest first,
 * each with its own preview. Previews are flat lists; `parentId` makes the
 * tree.
 *
 * Not market state, so not the engine's: this module writes `comments` only.
 * Comment bodies are stored as raw text (Markdown, rendered by the client).
 */

export const MAX_COMMENT_LENGTH = 2000;

/** How many recent comments a `relevance` sort considers. It is not paginated. */
export const RELEVANCE_WINDOW = 200;

/** How many replies to each comment, oldest first, a preview carries. */
export const REPLY_PREVIEW = 3;
/** How many levels of replies come with a page of top-level comments. */
export const LIST_DEPTH = 3;
/** How many levels below each reply come with a page of `listReplies`. */
export const REPLIES_DEPTH = 2;

export type CommentSort = 'newest' | 'relevance';

export interface CommentBackingView {
  /** Σ valueMicro. */
  totalMicro: bigint;
  byOutcome: { outcomeId: string; outcomeLabel: string; sharesMicro: bigint; valueMicro: bigint }[];
  /** Distinct accounts backing it. A count, never who. */
  backers: number;
  /** The viewer's own backing on it, per outcome. Empty when anonymous. */
  yours: { outcomeId: string; sharesMicro: bigint }[];
}

export interface CommentView {
  id: string;
  /** The comment it answers; null on a top-level comment. */
  parentId: string | null;
  body: string;
  createdAt: Date;
  /** Direct replies to it. */
  replyCount: number;
  author: {
    isBot: boolean;
    /** True when the viewer wrote it. Lets a client say "you" without revealing anyone else. */
    isYou: boolean;
    stake: { outcomeId: string; outcomeLabel: string; sharesMicro: bigint }[];
  };
  backing: CommentBackingView;
}

/** What the viewer could still put behind a comment on this market, per held outcome. */
export interface ViewerStake {
  available: { outcomeId: string; outcomeLabel: string; heldMicro: bigint; allocatedMicro: bigint }[];
}

/** A top-level comment, or with `parentId` a reply to a comment on the same market. */
export async function postComment(
  input: { marketId: string; accountId: string; body: string; parentId?: string | null },
  database: Database = getDb(),
): Promise<{ id: string; createdAt: Date }> {
  const body = input.body.trim();
  if (body.length === 0 || body.length > MAX_COMMENT_LENGTH) {
    throw new ApiError(400, 'validation_error', `a comment is 1–${MAX_COMMENT_LENGTH} characters`);
  }
  const parentId = input.parentId ?? null;
  if (parentId) {
    const [parent] = await database
      .select({ id: comments.id })
      .from(comments)
      .where(and(eq(comments.id, parentId), eq(comments.marketId, input.marketId)));
    if (!parent) throw new ApiError(404, 'not_found', `no comment ${parentId} on this market`);
  }
  const [row] = await database
    .insert(comments)
    .values({ marketId: input.marketId, accountId: input.accountId, parentId, body })
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

const commentColumns = {
  id: comments.id,
  body: comments.body,
  createdAt: comments.createdAt,
  ts: sql<string>`to_char(${comments.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
  accountId: comments.accountId,
  isBot: accounts.isBot,
  parentId: comments.parentId,
  // Uses comments_parent_created_idx. `r` is the reply; the outer row is `comments`.
  replyCount: sql<number>`(select count(*)::int from comments r where r.parent_id = ${comments.id})`,
};

type CommentRow = {
  id: string;
  body: string;
  createdAt: Date;
  ts: string;
  accountId: string;
  isBot: boolean;
  parentId: string | null;
  replyCount: number;
};

/**
 * A page of top-level comments, and in `replies` a preview of the replies
 * under them ({@link previewTree}).
 * `newest` (default): newest first, keyset-paginated like every other list.
 * `relevance`: the {@link RELEVANCE_WINDOW} most recent, by backing value
 * (highest first), ties newest first; one page, `nextCursor` null.
 * `total` counts every comment on the market, replies included.
 */
export async function listComments(
  marketId: string,
  q: { cursor?: string; limit: number; viewerAccountId?: string | null; sort?: CommentSort },
  database: Database = getDb(),
): Promise<{
  comments: CommentView[];
  replies: CommentView[];
  nextCursor: string | null;
  total: number;
  viewer: ViewerStake | null;
}> {
  const sort = q.sort ?? 'newest';
  if (sort === 'relevance' && q.cursor !== undefined) {
    throw new ApiError(400, 'validation_error', 'the relevance sort is a single page and takes no cursor');
  }
  const before = decodeCursor(q.cursor);
  const [market] = await database.select().from(markets).where(eq(markets.id, marketId));
  if (!market) throw new ApiError(404, 'not_found', `no market ${marketId}`);

  const [rows, [{ total }]] = await Promise.all([
    database
      .select(commentColumns)
      .from(comments)
      .innerJoin(accounts, eq(accounts.id, comments.accountId))
      .where(
        and(
          eq(comments.marketId, marketId),
          isNull(comments.parentId),
          before
            ? sql`(${comments.createdAt}, ${comments.id}) < (${before.t}::timestamptz, ${before.id}::uuid)`
            : undefined,
        ),
      )
      .orderBy(desc(comments.createdAt), desc(comments.id))
      .limit(sort === 'relevance' ? RELEVANCE_WINDOW : q.limit + 1),
    database
      .select({ total: sql<number>`count(*)::int` })
      .from(comments)
      .where(eq(comments.marketId, marketId)),
  ]);

  const viewerAccountId = q.viewerAccountId ?? null;
  let page: CommentRow[];
  let nextCursor: string | null = null;
  if (sort === 'relevance') {
    const all = await decorate(market, rows, viewerAccountId, database);
    // Stable sort: rows are newest first, so ties stay newest first.
    all.sort((a, b) =>
      a.backing.totalMicro === b.backing.totalMicro ? 0 : a.backing.totalMicro > b.backing.totalMicro ? -1 : 1,
    );
    const byId = new Map(rows.map((r) => [r.id, r]));
    page = all.slice(0, q.limit).map((c) => byId.get(c.id)!);
  } else {
    page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    if (rows.length > q.limit && last) nextCursor = encodeCursor({ t: last.ts, id: last.id });
  }

  const replies = await previewTree(
    page.map((r) => r.id),
    LIST_DEPTH,
    database,
  );
  const views = await decorate(market, [...page, ...replies], viewerAccountId, database);
  return {
    comments: views.slice(0, page.length),
    replies: views.slice(page.length),
    nextCursor,
    total,
    viewer: await viewerStake(market.id, viewerAccountId, database),
  };
}

/**
 * The replies under these comments that a preview shows: the first
 * {@link REPLY_PREVIEW} replies to each, oldest first, and so on `depth`
 * levels down. One recursive query; flat, oldest first.
 */
async function previewTree(parentIds: string[], depth: number, database: Database): Promise<CommentRow[]> {
  if (parentIds.length === 0 || depth < 1) return [];
  const ids = sql.join(
    parentIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  // Each step takes the first few replies of every comment found so far, by
  // comments_parent_created_idx.
  const tree = sql`
    with recursive tree (id, depth) as (
      select id, 1 from (
        select id, row_number() over (partition by parent_id order by created_at, id) as rn
        from comments where parent_id in (${ids})
      ) first where rn <= ${REPLY_PREVIEW}
      union all
      select next.id, tree.depth + 1 from tree
      cross join lateral (
        select id from comments where parent_id = tree.id order by created_at, id limit ${REPLY_PREVIEW}
      ) next
      where tree.depth < ${depth}
    )
    select id from tree`;
  return database
    .select(commentColumns)
    .from(comments)
    .innerJoin(accounts, eq(accounts.id, comments.accountId))
    .where(sql`${comments.id} in (${tree})`)
    .orderBy(asc(comments.createdAt), asc(comments.id));
}

/**
 * A comment's direct replies, oldest first, after the reply `after` (the
 * last one the client has), `limit` of them, and a preview of the replies
 * under each ({@link REPLIES_DEPTH} levels). Flat: `parentId` makes the tree.
 * Whether more remain is the comment's `replyCount` against what is loaded.
 */
export async function listReplies(
  commentId: string,
  q: { after?: string; limit: number; viewerAccountId?: string | null },
  database: Database = getDb(),
): Promise<{ marketId: string; replies: CommentView[] }> {
  const [parent] = await database
    .select({ market: markets })
    .from(comments)
    .innerJoin(markets, eq(markets.id, comments.marketId))
    .where(eq(comments.id, commentId));
  if (!parent) throw new ApiError(404, 'not_found', `no comment ${commentId}`);
  if (q.after) {
    const [after] = await database
      .select({ id: comments.id })
      .from(comments)
      .where(and(eq(comments.id, q.after), eq(comments.parentId, commentId)));
    if (!after) throw new ApiError(400, 'validation_error', '`after` is not a reply to this comment');
  }

  const page: CommentRow[] = await database
    .select(commentColumns)
    .from(comments)
    .innerJoin(accounts, eq(accounts.id, comments.accountId))
    .where(
      and(
        eq(comments.parentId, commentId),
        // Compared in SQL, at the column's microseconds: a JS Date would round them away.
        q.after
          ? sql`(${comments.createdAt}, ${comments.id}) > (select c.created_at, c.id from comments c where c.id = ${q.after}::uuid)`
          : undefined,
      ),
    )
    .orderBy(asc(comments.createdAt), asc(comments.id))
    .limit(q.limit);
  const below = await previewTree(
    page.map((r) => r.id),
    REPLIES_DEPTH,
    database,
  );
  return {
    marketId: parent.market.id,
    replies: await decorate(parent.market, [...page, ...below], q.viewerAccountId ?? null, database),
  };
}

/** One comment, as `listComments` would show it, or `null`. */
export async function getComment(
  commentId: string,
  viewerAccountId: string | null,
  database: Database = getDb(),
): Promise<CommentView | null> {
  const [row] = await database
    .select({ ...commentColumns, market: markets })
    .from(comments)
    .innerJoin(accounts, eq(accounts.id, comments.accountId))
    .innerJoin(markets, eq(markets.id, comments.marketId))
    .where(eq(comments.id, commentId));
  if (!row) return null;
  const [view] = await decorate(row.market, [row], viewerAccountId, database);
  return view;
}

/** Authors' stakes and backings for a set of comments on one market. */
async function decorate(
  market: Market,
  rows: CommentRow[],
  viewerAccountId: string | null,
  database: Database,
): Promise<CommentView[]> {
  if (rows.length === 0) return [];
  const authorIds = [...new Set(rows.map((r) => r.accountId))];
  const commentIds = rows.map((r) => r.id);

  const [board, stakes, backed] = await Promise.all([
    database.select().from(outcomes).where(eq(outcomes.marketId, market.id)).orderBy(asc(outcomes.ordinal)),
    database
      .select({
        accountId: positions.accountId,
        outcomeId: outcomes.id,
        outcomeLabel: outcomes.label,
        sharesMicro: positions.sharesMicro,
      })
      .from(positions)
      .innerJoin(outcomes, eq(outcomes.id, positions.outcomeId))
      .where(
        and(eq(outcomes.marketId, market.id), inArray(positions.accountId, authorIds), gt(positions.sharesMicro, 0n)),
      )
      .orderBy(outcomes.ordinal),
    database
      .select({
        commentId: commentBackings.commentId,
        accountId: commentBackings.accountId,
        outcomeId: commentBackings.outcomeId,
        // sum(bigint) is numeric: read it as text (§1.6).
        shares: sql<string>`sum(${commentBackings.sharesMicro})::text`,
      })
      .from(commentBackings)
      .where(inArray(commentBackings.commentId, commentIds))
      .groupBy(commentBackings.commentId, commentBackings.accountId, commentBackings.outcomeId),
  ]);

  const value = backingValuer(market, board);

  return rows.map((r) => {
    const mine = backed.filter((b) => b.commentId === r.id);
    const byOutcome = board
      .map((o) => {
        const sharesMicro = mine.filter((b) => b.outcomeId === o.id).reduce((s, b) => s + BigInt(b.shares), 0n);
        return { outcomeId: o.id, outcomeLabel: o.label, sharesMicro, valueMicro: value(o.id, sharesMicro) };
      })
      .filter((o) => o.sharesMicro > 0n);
    return {
      id: r.id,
      parentId: r.parentId,
      body: r.body,
      createdAt: r.createdAt,
      replyCount: r.replyCount,
      author: {
        isBot: r.isBot,
        isYou: viewerAccountId === r.accountId,
        stake: stakes
          .filter((s) => s.accountId === r.accountId)
          .map((s) => ({ outcomeId: s.outcomeId, outcomeLabel: s.outcomeLabel, sharesMicro: s.sharesMicro })),
      },
      backing: {
        totalMicro: byOutcome.reduce((s, o) => s + o.valueMicro, 0n),
        byOutcome,
        backers: new Set(mine.map((b) => b.accountId)).size,
        yours: viewerAccountId
          ? board
              .map((o) => ({
                outcomeId: o.id,
                sharesMicro: mine
                  .filter((b) => b.accountId === viewerAccountId && b.outcomeId === o.id)
                  .reduce((s, b) => s + BigInt(b.shares), 0n),
              }))
              .filter((y) => y.sharesMicro > 0n)
          : [],
      },
    };
  });
}

/**
 * Backed shares → a relevance weight, in micro-units. A **mark**
 * (shares × price), rounded once as `getPortfolio` rounds its marks; exact
 * after settlement (1 per winning share, 0 otherwise); 0 on a void market.
 */
function backingValuer(market: Market, board: (typeof outcomes.$inferSelect)[]) {
  const p =
    board.length >= 2
      ? prices(
          board.map((o) => microToFloat(o.sharesMicro)),
          market.b,
        )
      : [];
  const index = new Map(board.map((o, i) => [o.id, i]));
  return (outcomeId: string, sharesMicro: bigint): bigint => {
    if (sharesMicro === 0n) return 0n;
    if (market.status === 'settled') return outcomeId === market.resolvedOutcomeId ? sharesMicro : 0n;
    if (market.status === 'void') return 0n;
    return costToMicro(microToFloat(sharesMicro) * p[index.get(outcomeId)!]);
  };
}

/** The viewer's held outcomes on this market with what is already backed. `null` when anonymous. */
export async function viewerStake(
  marketId: string,
  viewerAccountId: string | null,
  database: Database = getDb(),
): Promise<ViewerStake | null> {
  if (!viewerAccountId) return null;
  const rows = await database
    .select({
      outcomeId: outcomes.id,
      outcomeLabel: outcomes.label,
      heldMicro: positions.sharesMicro,
      allocated: sql<string>`(select coalesce(sum(${commentBackings.sharesMicro}), 0)::text from ${commentBackings}
        where ${commentBackings.accountId} = ${positions.accountId} and ${commentBackings.outcomeId} = ${positions.outcomeId})`,
    })
    .from(positions)
    .innerJoin(outcomes, eq(outcomes.id, positions.outcomeId))
    .where(
      and(eq(outcomes.marketId, marketId), eq(positions.accountId, viewerAccountId), gt(positions.sharesMicro, 0n)),
    )
    .orderBy(outcomes.ordinal);
  return {
    available: rows.map((r) => ({
      outcomeId: r.outcomeId,
      outcomeLabel: r.outcomeLabel,
      heldMicro: r.heldMicro,
      allocatedMicro: BigInt(r.allocated),
    })),
  };
}
