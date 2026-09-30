import { and, asc, desc, eq, inArray, type SQL } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { getDb } from '@/db';
import * as schema from '@/db/schema';
import { accounts, listings, markets, orders, outcomes, positions, publicPositions } from '@/db/schema';
import { costBasis } from '@/lib/cost-basis';
import { prices } from '@/lib/lmsr';
import { microToFloat } from '@/lib/money';
import { ApiError } from './api/errors';
import { quote } from './engine';

type Database = NodePgDatabase<typeof schema>;

/**
 * Public positions (#36): a trader may make one of their positions public,
 * to share it by link and list it on their `/people/<handle>` page.
 *
 * **It unmasks their comments on that market.** A comment shows its author's
 * stake and nothing else (`server/comments.ts`), so a named position of the
 * same size is a signature. That is why it is opt-in, one position at a time,
 * and why the UI warns before it is made; nothing else about a trader's
 * positions is ever public.
 *
 * What is shown is read live, from `orders`, like closed positions
 * (`accounts.closedPositions`): the net of the fills is what is held now, or
 * what was held into settlement. Values are the exit quote while trading and
 * the payout once settled, never the mark (§1.1). Written here, in single
 * statements, never by the engine.
 */

export type PublicPositionState = 'held' | 'sold' | 'won' | 'lost' | 'void';

export interface PublicPositionView {
  id: string;
  createdAt: Date;
  trader: { handle: string; displayName: string; isBot: boolean };
  market: {
    id: string;
    slug: string;
    question: string;
    kind: string;
    status: (typeof markets.$inferSelect)['status'];
    listingSlug: string | null;
    listingTitle: string | null;
  };
  outcome: { id: string; label: string; ordinal: number; count: number };
  /** The outcome's price now. A probability, not a value. */
  price: number;
  /** Shares held when it was made public. */
  sharedSharesMicro: bigint;
  /** Shares held now; once settled, those held into settlement. */
  heldMicro: bigint;
  boughtMicro: bigint;
  /** Σ cost of the buys. */
  paidMicro: bigint;
  /** Σ proceeds of the sells. */
  soldMicro: bigint;
  /** What the shares held cost, by average cost (`lib/cost-basis.ts`). Not a value. */
  costBasisMicro: bigint;
  /** What selling the shares held would pay now: null unless the market trades and something is held. Never the mark. */
  quotedExitMicro: bigint | null;
  /** 1 per share held into settlement if this outcome won, else 0. */
  payoutMicro: bigint;
  /** `sold + payout + quoted exit − paid`: what it has made, if what is left were sold now. */
  pnlMicro: bigint;
  state: PublicPositionState;
}

/**
 * Make a position public. Only one the account holds now: a position is
 * shared for what it is, and cannot be announced before it exists.
 * Idempotent: an already public position keeps its link and its
 * `sharedSharesMicro`.
 */
export async function publish(
  accountId: string,
  outcomeId: string,
  database: Database = getDb(),
): Promise<PublicPositionView> {
  const [held] = await database
    .select({ sharesMicro: positions.sharesMicro })
    .from(positions)
    .where(and(eq(positions.accountId, accountId), eq(positions.outcomeId, outcomeId)));
  const [existing] = await database
    .select({ id: publicPositions.id })
    .from(publicPositions)
    .where(and(eq(publicPositions.accountId, accountId), eq(publicPositions.outcomeId, outcomeId)));
  if (!existing) {
    if (!held || held.sharesMicro <= 0n) {
      throw new ApiError(409, 'insufficient_shares', 'only a position you hold can be made public');
    }
    // A single statement. Its FK check waits out a trade holding this
    // account's row, and holds nothing a trade could be waiting on.
    await database
      .insert(publicPositions)
      .values({ accountId, outcomeId, sharedSharesMicro: held.sharesMicro })
      .onConflictDoNothing();
  }
  const [view] = await read(and(eq(publicPositions.accountId, accountId), eq(publicPositions.outcomeId, outcomeId)), database);
  return view;
}

/** Make it private again; its link stops working. Idempotent. */
export async function unpublish(accountId: string, outcomeId: string, database: Database = getDb()): Promise<boolean> {
  const rows = await database
    .delete(publicPositions)
    .where(and(eq(publicPositions.accountId, accountId), eq(publicPositions.outcomeId, outcomeId)))
    .returning({ id: publicPositions.id });
  return rows.length > 0;
}

/** One public position by its link id; 404 when there is none (or it was made private). */
export async function publicPosition(id: string, database: Database = getDb()): Promise<PublicPositionView> {
  const [view] = await read(eq(publicPositions.id, id), database);
  if (!view) throw new ApiError(404, 'not_found', `no public position ${id}`);
  return view;
}

/** An account's public positions, newest first. */
export async function publicPositionsOf(accountId: string, database: Database = getDb()): Promise<PublicPositionView[]> {
  return read(eq(publicPositions.accountId, accountId), database);
}

/** outcome id → link id, of an account's public positions. For the owner's own tables. */
export async function publicPositionIds(accountId: string, database: Database = getDb()): Promise<Map<string, string>> {
  const rows = await database
    .select({ id: publicPositions.id, outcomeId: publicPositions.outcomeId })
    .from(publicPositions)
    .where(eq(publicPositions.accountId, accountId));
  return new Map(rows.map((r) => [r.outcomeId, r.id]));
}

async function read(where: SQL | undefined, database: Database): Promise<PublicPositionView[]> {
  const rows = await database
    .select({
      row: publicPositions,
      handle: accounts.handle,
      displayName: accounts.displayName,
      isBot: accounts.isBot,
      outcome: outcomes,
      market: markets,
      listingSlug: listings.slug,
      listingTitle: listings.title,
    })
    .from(publicPositions)
    .innerJoin(accounts, eq(accounts.id, publicPositions.accountId))
    .innerJoin(outcomes, eq(outcomes.id, publicPositions.outcomeId))
    .innerJoin(markets, eq(markets.id, outcomes.marketId))
    .leftJoin(listings, eq(listings.id, markets.listingId))
    // House accounts never trade, so never have one; excluded all the same, as from every public page.
    .where(and(where, eq(accounts.isHouse, false)))
    .orderBy(desc(publicPositions.createdAt), asc(publicPositions.id));
  if (rows.length === 0) return [];

  const fills = await database
    .select({
      accountId: orders.accountId,
      outcomeId: orders.outcomeId,
      sharesMicro: orders.sharesMicro,
      costMicro: orders.costMicro,
    })
    .from(orders)
    .innerJoin(
      publicPositions,
      and(eq(publicPositions.accountId, orders.accountId), eq(publicPositions.outcomeId, orders.outcomeId)),
    )
    .where(inArray(publicPositions.id, rows.map((r) => r.row.id)))
    .orderBy(asc(orders.createdAt), asc(orders.id));

  const boards = new Map<string, (typeof outcomes.$inferSelect)[]>();
  const marketIds = [...new Set(rows.map((r) => r.market.id))];
  for (const o of await database
    .select()
    .from(outcomes)
    .where(inArray(outcomes.marketId, marketIds))
    .orderBy(asc(outcomes.ordinal))) {
    boards.set(o.marketId, [...(boards.get(o.marketId) ?? []), o]);
  }

  const views: PublicPositionView[] = [];
  for (const { row, market, outcome, ...r } of rows) {
    const own = fills.filter((f) => f.accountId === row.accountId && f.outcomeId === row.outcomeId);
    let held = 0n;
    let bought = 0n;
    let paid = 0n;
    let sold = 0n;
    for (const f of own) {
      held += f.sharesMicro;
      if (f.sharesMicro > 0n) {
        bought += f.sharesMicro;
        paid += f.costMicro;
      } else {
        sold -= f.costMicro;
      }
    }
    const board = boards.get(market.id) ?? [];
    const index = board.findIndex((o) => o.id === outcome.id);
    const price = prices(
      board.map((o) => microToFloat(o.sharesMicro)),
      market.b,
    )[index];

    const settled = market.status === 'settled';
    const won = settled && market.resolvedOutcomeId === outcome.id;
    const payout = won ? held : 0n;
    const trading = market.status === 'open' || market.status === 'closed';
    const exit = trading && held > 0n ? -(await quote(market.id, outcome.id, -held, database)).costMicro : null;
    const state: PublicPositionState =
      market.status === 'void' ? 'void' : settled && held > 0n ? (won ? 'won' : 'lost') : held > 0n ? 'held' : 'sold';

    views.push({
      id: row.id,
      createdAt: row.createdAt,
      trader: { handle: r.handle, displayName: r.displayName, isBot: r.isBot },
      market: {
        id: market.id,
        slug: market.slug,
        question: market.question,
        kind: market.kind,
        status: market.status,
        listingSlug: r.listingSlug,
        listingTitle: r.listingTitle,
      },
      outcome: { id: outcome.id, label: outcome.label, ordinal: index, count: board.length },
      price,
      sharedSharesMicro: row.sharedSharesMicro,
      heldMicro: held,
      boughtMicro: bought,
      paidMicro: paid,
      soldMicro: sold,
      costBasisMicro: costBasis(own).basisMicro,
      quotedExitMicro: exit,
      payoutMicro: payout,
      pnlMicro: sold + payout + (exit ?? 0n) - paid,
      state,
    });
  }
  return views;
}
