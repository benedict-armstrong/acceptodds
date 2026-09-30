/* eslint-disable @typescript-eslint/no-explicit-any -- response bodies are checked field by field */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { accounts } from '@/db/schema';
import { createMarket, quote, settle, trade } from '@/server/engine';
import { upsertListing } from '@/server/listings';
import { api, trader } from './api-client';
import { closePool, resetDatabase, seedMarket, STARTING_MICRO } from './helpers';

const db = getDb();
const UNIT = 1_000_000n;

let market: { marketId: string; outcomeIds: string[] };

beforeEach(async () => {
  await resetDatabase();
  process.env.API_RATE_LIMIT_BURST = '1000';
  process.env.API_RATE_LIMIT_PER_SECOND = '1000';
  process.env.STARTING_BALANCE_MICRO = STARTING_MICRO.toString();
  await seedMarket(0, 10); // the house
  const { listing } = await upsertListing({ slug: 'paper', title: 'A Paper', kind: 'ICLR 2027' });
  market = await createMarket({
    slug: 'paper-decision',
    question: 'Decision?',
    outcomes: ['Oral', 'Poster', 'Reject'],
    closesAt: new Date(Date.now() + 7 * 86_400_000),
    startingBalanceMicro: STARTING_MICRO,
    expectedTraders: 10,
    status: 'open',
    listingId: listing.id,
  });
}, 60_000);

afterAll(async () => {
  await closePool();
});

async function fill(accountId: string, outcomeId: string, sharesMicro: bigint) {
  const q = await quote(market.marketId, outcomeId, sharesMicro, db);
  return trade(accountId, market.marketId, outcomeId, sharesMicro, q.costMicro, null, db);
}

async function gain(accountId: string): Promise<bigint> {
  const [a] = await db.select().from(accounts).where(eq(accounts.id, accountId));
  return a.balanceMicro - STARTING_MICRO;
}

describe('public positions', () => {
  it('is opt-in: nothing is public until the holder makes it so, and only what they hold', async () => {
    const alice = await trader('alice');
    const [oral, poster] = market.outcomeIds;
    await fill(alice.id, oral, 10n * UNIT);

    expect((await api('GET', '/accounts/alice/positions')).body).toEqual({ positions: [] });
    const portfolio = await api('GET', '/me/portfolio', { token: alice.token });
    expect(portfolio.body.holdings[0].publicPositionId).toBeNull();

    const none = await api('PUT', `/me/positions/${poster}/public`, { token: alice.token });
    expect(none.status).toBe(409);
    expect(none.body.error.code).toBe('insufficient_shares');
    expect((await api('PUT', `/me/positions/${oral}/public`)).status).toBe(401);
    const reader = await trader('reader', ['read']);
    expect((await api('PUT', `/me/positions/${oral}/public`, { token: reader.token })).status).toBe(403);

    const on = await api('PUT', `/me/positions/${oral}/public`, { token: alice.token });
    expect(on.status).toBe(200);
    const id = on.body.publicPositionId;
    expect(on.body).toEqual({ outcomeId: oral, publicPositionId: id });
    // Idempotent: the same link.
    expect((await api('PUT', `/me/positions/${oral}/public`, { token: alice.token })).body.publicPositionId).toBe(id);
    expect((await api('GET', '/me/portfolio', { token: alice.token })).body.holdings[0].publicPositionId).toBe(id);

    const listed = (await api('GET', '/accounts/alice/positions')).body.positions;
    expect(listed.map((p: any) => p.id)).toEqual([id]);
    // No one else's, and a house account is not a person.
    expect((await api('GET', '/accounts/reader/positions')).body.positions).toEqual([]);
    expect((await api('GET', '/accounts/house/positions')).status).toBe(404);
  });

  it('follows the position live: held, sold since, and never a mark', async () => {
    const alice = await trader('alice');
    const [oral] = market.outcomeIds;
    await fill(alice.id, oral, 10n * UNIT);
    const id = (await api('PUT', `/me/positions/${oral}/public`, { token: alice.token })).body.publicPositionId;

    const held = await api('GET', `/positions/${id}`);
    expect(held.status).toBe(200);
    expect(held.body).toMatchObject({
      trader: { handle: 'alice', displayName: 'alice', isBot: false },
      market: { slug: 'paper-decision', listingSlug: 'paper', listingTitle: 'A Paper', status: 'open' },
      outcome: { id: oral, label: 'Oral', ordinal: 0, count: 3 },
      state: 'held',
      sharedSharesMicro: (10n * UNIT).toString(),
      heldMicro: (10n * UNIT).toString(),
    });
    // The exit quote, which is what selling pays: exactly what the engine quotes.
    const exit = -(await quote(market.marketId, oral, -10n * UNIT, db)).costMicro;
    expect(held.body.quotedExitMicro).toBe(exit.toString());
    expect(held.body).not.toHaveProperty('markMicro');
    // Right after a buy the round trip is a small loss, never a self-marked gain.
    expect(BigInt(held.body.pnlMicro)).toBeLessThanOrEqual(0n);

    await fill(alice.id, oral, -10n * UNIT);
    const sold = (await api('GET', `/positions/${id}`)).body;
    expect(sold).toMatchObject({ state: 'sold', heldMicro: '0', quotedExitMicro: null, costBasisMicro: '0' });
    expect(sold.sharedSharesMicro).toBe((10n * UNIT).toString());
    // Sold out, the P&L is exact: the ledger's own figure.
    expect(BigInt(sold.pnlMicro)).toBe(await gain(alice.id));
    // Still listed: it was made public, and selling does not hide it.
    expect((await api('GET', '/accounts/alice/positions')).body.positions).toHaveLength(1);
  });

  it('shows the result once settled, with the exact payout', async () => {
    const alice = await trader('alice');
    const bob = await trader('bob');
    const [oral, , reject] = market.outcomeIds;
    await fill(alice.id, oral, 5n * UNIT);
    await fill(bob.id, reject, 3n * UNIT);
    const a = (await api('PUT', `/me/positions/${oral}/public`, { token: alice.token })).body.publicPositionId;
    const b = (await api('PUT', `/me/positions/${reject}/public`, { token: bob.token })).body.publicPositionId;

    await settle(market.marketId, oral, {}, db);

    const won = (await api('GET', `/positions/${a}`)).body;
    expect(won).toMatchObject({ state: 'won', heldMicro: (5n * UNIT).toString(), payoutMicro: (5n * UNIT).toString() });
    expect(BigInt(won.pnlMicro)).toBe(await gain(alice.id));
    const lost = (await api('GET', `/positions/${b}`)).body;
    expect(lost).toMatchObject({ state: 'lost', payoutMicro: '0' });
    expect(BigInt(lost.pnlMicro)).toBe(await gain(bob.id));
  });

  it('made private, its link 404s and it leaves the profile', async () => {
    const alice = await trader('alice');
    const [oral] = market.outcomeIds;
    await fill(alice.id, oral, UNIT);
    const id = (await api('PUT', `/me/positions/${oral}/public`, { token: alice.token })).body.publicPositionId;

    const off = await api('DELETE', `/me/positions/${oral}/public`, { token: alice.token });
    expect(off.body).toEqual({ outcomeId: oral, publicPositionId: null });
    expect((await api('DELETE', `/me/positions/${oral}/public`, { token: alice.token })).status).toBe(200);
    expect((await api('GET', `/positions/${id}`)).status).toBe(404);
    expect((await api('GET', '/accounts/alice/positions')).body.positions).toEqual([]);
    expect((await api('GET', '/positions/not-a-uuid')).status).toBe(400);

    // Made public again, it is a new link: the old one stays dead.
    const again = (await api('PUT', `/me/positions/${oral}/public`, { token: alice.token })).body.publicPositionId;
    expect(again).not.toBe(id);
  });
});
