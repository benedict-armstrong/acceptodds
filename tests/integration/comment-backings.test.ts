/* eslint-disable @typescript-eslint/no-explicit-any -- response bodies are checked field by field */
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '@/db';
import { commentBackings, positions } from '@/db/schema';
import { costToMicro } from '@/lib/money';
import { backComment } from '@/server/backings';
import { closeMarket, createMarket, settle, trade } from '@/server/engine';
import { api, trader } from './api-client';
import { closePool, resetDatabase, seedMarket, STARTING_MICRO, type Fixture } from './helpers';

const db = getDb();
let fx: Fixture;

beforeEach(async () => {
  await resetDatabase();
  process.env.API_RATE_LIMIT_BURST = '1000';
  process.env.API_RATE_LIMIT_PER_SECOND = '1000';
  fx = await seedMarket(0, 10);
}, 60_000);

afterAll(async () => {
  await closePool();
});

const U = 1_000_000n;
const units = (n: number) => (BigInt(n) * U).toString();

const buy = (token: string, outcomeId: string, n: number) =>
  api('POST', `/markets/${fx.marketId}/orders`, {
    token,
    body: { outcomeId, sharesMicro: units(n), maxCostMicro: '1000000000' },
  });
const sell = (token: string, outcomeId: string, n: number) =>
  api('POST', `/markets/${fx.marketId}/orders`, {
    token,
    body: { outcomeId, sharesMicro: `-${units(n)}`, maxCostMicro: '0' },
  });
async function comment(token: string, body: string): Promise<string> {
  const res = await api('POST', `/markets/${fx.marketId}/comments`, { token, body: { body } });
  expect(res.status).toBe(201);
  return res.body.id;
}
const back = (token: string, commentId: string, outcomeId: string, n: number | string) =>
  api('POST', `/comments/${commentId}/backing`, {
    token,
    body: { outcomeId, sharesMicro: typeof n === 'number' ? units(n) : n },
  });
const list = (token?: string, query = '') => api('GET', `/markets/${fx.marketId}/comments${query}`, { token });
const byId = (body: any, id: string) => body.comments.find((c: any) => c.id === id);

async function backedMicro(accountId: string, outcomeId: string): Promise<bigint> {
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${commentBackings.sharesMicro}), 0)::text` })
    .from(commentBackings)
    .where(and(eq(commentBackings.accountId, accountId), eq(commentBackings.outcomeId, outcomeId)));
  return BigInt(row.total);
}
async function heldMicro(accountId: string, outcomeId: string): Promise<bigint> {
  const [row] = await db
    .select()
    .from(positions)
    .where(and(eq(positions.accountId, accountId), eq(positions.outcomeId, outcomeId)));
  return row?.sharesMicro ?? 0n;
}

describe('comment bodies', () => {
  it('store Markdown and math as raw text and return it verbatim', async () => {
    const t = await trader('writer');
    const body = '# Claim\n\n**Novel**: $\\mathcal{O}(n \\log n)$ beats\n\n$$\\sum_i x_i^2$$\n\n- a\n- b\n\n<script>alert(1)</script> [x](javascript:alert(1))';
    const id = await comment(t.token, `  ${body}\n `);
    expect(byId((await list()).body, id).body).toBe(body);
  });
});

describe('backing a comment', () => {
  it('puts held shares behind a comment, marked at the current price, anonymously', async () => {
    const alice = await trader('alice-secret');
    const bob = await trader('bob-secret');
    const [yes] = fx.outcomeIds;
    const id = await comment(alice.token, 'YES, clearly');
    await buy(bob.token, yes, 20);

    const res = await back(bob.token, id, yes, 10);
    expect(res.status).toBe(201);
    const price = (await api('GET', `/markets/${fx.marketId}`)).body.outcomes[0].price;
    const value = costToMicro(10_000_000 * price).toString();
    expect(res.body.backing).toEqual({
      totalMicro: value,
      byOutcome: [{ outcomeId: yes, outcomeLabel: 'YES', sharesMicro: units(10), valueMicro: value }],
      backers: 1,
      yours: [{ outcomeId: yes, sharesMicro: units(10) }],
    });

    // Anonymous readers see the total and a count, never who, and no viewer block.
    const anon = await list();
    expect(byId(anon.body, id).backing.yours).toEqual([]);
    expect(byId(anon.body, id).backing.backers).toBe(1);
    expect(anon.body.viewer).toBeNull();
    const raw = JSON.stringify(anon.body) + JSON.stringify(res.body);
    for (const secret of [alice.id, bob.id, 'alice-secret', 'bob-secret']) expect(raw).not.toContain(secret);

    // The backer sees what is left to allocate.
    const mine = await list(bob.token);
    expect(mine.body.viewer).toEqual({
      available: [{ outcomeId: yes, outcomeLabel: 'YES', heldMicro: units(20), allocatedMicro: units(10) }],
    });
    // The author sees it too, but not as theirs.
    expect(byId((await list(alice.token)).body, id).backing.yours).toEqual([]);
  });

  it('never allocates more than is held, across comments, and never to your own comment', async () => {
    const alice = await trader('alice');
    const bob = await trader('bob');
    const [yes, no] = fx.outcomeIds;
    const a = await comment(alice.token, 'a');
    const b = await comment(alice.token, 'b');
    const c = await comment(alice.token, 'c');
    const own = await comment(bob.token, 'mine');
    await buy(bob.token, yes, 20);

    expect((await back(bob.token, a, yes, 10)).status).toBe(201);
    expect((await back(bob.token, b, yes, 10)).status).toBe(201);
    const over = await back(bob.token, c, yes, '1');
    expect(over.status).toBe(409);
    expect(over.body.error).toMatchObject({
      code: 'insufficient_stake',
      details: { heldMicro: units(20), allocatedMicro: units(20), availableMicro: '0' },
    });
    // Backing the same comment again adds to it, within the limit.
    expect((await back(bob.token, a, yes, 1)).body.error.code).toBe('insufficient_stake');
    // An outcome not held at all.
    expect((await back(bob.token, a, no, 1)).body.error.code).toBe('insufficient_stake');
    expect((await back(bob.token, own, yes, 1)).body.error.code).toBe('own_comment');

    const other = await createMarket({
      slug: 'other',
      question: 'other',
      outcomes: ['YES', 'NO'],
      closesAt: new Date(Date.now() + 86_400_000),
      startingBalanceMicro: STARTING_MICRO,
      expectedTraders: 10,
    });
    expect((await back(bob.token, a, other.outcomeIds[0], 1)).status).toBe(404);
    expect((await back(bob.token, '00000000-0000-4000-8000-000000000000', yes, 1)).status).toBe(404);
    expect((await back(bob.token, 'nope', yes, 1)).status).toBe(400);
    for (const n of ['0', '-5', 'x']) expect((await back(bob.token, a, yes, n)).status).toBe(400);

    expect(await backedMicro(bob.id, yes)).toBe(20n * U);
  });

  it('needs the trade scope and a trading-eligible account, like posting', async () => {
    const alice = await trader('alice');
    const reader = await trader('reader', ['read']);
    const unverified = await trader('unverified', ['read', 'trade'], { verified: false });
    const id = await comment(alice.token, 'x');
    expect((await api('POST', `/comments/${id}/backing`, { body: { outcomeId: fx.outcomeIds[0], sharesMicro: '1' } })).status).toBe(401);
    expect((await back(reader.token, id, fx.outcomeIds[0], 1)).status).toBe(403);
    expect((await back(unverified.token, id, fx.outcomeIds[0], 1)).body.error.code).toBe('not_verified');
    expect((await api('DELETE', `/comments/${id}/backing`, { token: reader.token })).status).toBe(403);
    expect((await api('GET', `/comments/${id}/backing`)).status).toBe(405);
  });

  it('is only for open markets', async () => {
    const alice = await trader('alice');
    const bob = await trader('bob');
    const id = await comment(alice.token, 'x');
    await buy(bob.token, fx.outcomeIds[0], 5);
    await closeMarket(fx.marketId);
    expect((await back(bob.token, id, fx.outcomeIds[0], 1)).body.error.code).toBe('market_not_open');
  });

  it('can be withdrawn, idempotently', async () => {
    const alice = await trader('alice');
    const bob = await trader('bob');
    const [yes] = fx.outcomeIds;
    const id = await comment(alice.token, 'x');
    await buy(bob.token, yes, 10);
    await back(bob.token, id, yes, 4);
    await back(bob.token, id, yes, 3);
    expect(byId((await list(bob.token)).body, id).backing.yours).toEqual([{ outcomeId: yes, sharesMicro: units(7) }]);

    expect((await api('DELETE', `/comments/${id}/backing`, { token: bob.token })).status).toBe(204);
    expect((await api('DELETE', `/comments/${id}/backing`, { token: bob.token })).status).toBe(204);
    const after = byId((await list(bob.token)).body, id).backing;
    expect(after).toEqual({ totalMicro: '0', byOutcome: [], backers: 0, yours: [] });
    expect((await api('DELETE', '/comments/00000000-0000-4000-8000-000000000000/backing', { token: bob.token })).status).toBe(404);
    // And the stake is free again.
    expect((await back(bob.token, id, yes, 10)).status).toBe(201);
  });
});

describe('selling trims backings, newest first', () => {
  it('back A 10 then B 10 holding 20, sell 15: B is removed, A drops to 5', async () => {
    const alice = await trader('alice');
    const bob = await trader('bob');
    const [yes] = fx.outcomeIds;
    const a = await comment(alice.token, 'A');
    const b = await comment(alice.token, 'B');
    await buy(bob.token, yes, 20);
    await back(bob.token, a, yes, 10);
    await back(bob.token, b, yes, 10);

    expect((await sell(bob.token, yes, 15)).status).toBe(201);
    const body = (await list(bob.token)).body;
    expect(byId(body, a).backing.yours).toEqual([{ outcomeId: yes, sharesMicro: units(5) }]);
    expect(byId(body, b).backing).toMatchObject({ backers: 0, yours: [], byOutcome: [] });
    expect(body.viewer.available).toEqual([
      { outcomeId: yes, outcomeLabel: 'YES', heldMicro: units(5), allocatedMicro: units(5) },
    ]);
  });

  it('a sell within the unallocated shares touches nothing; buying the other outcome touches nothing', async () => {
    const alice = await trader('alice');
    const bob = await trader('bob');
    const [yes, no] = fx.outcomeIds;
    const a = await comment(alice.token, 'A');
    await buy(bob.token, yes, 20);
    await buy(bob.token, no, 5);
    await back(bob.token, a, yes, 8);
    await back(bob.token, a, no, 5);
    await sell(bob.token, yes, 12);
    expect(await backedMicro(bob.id, yes)).toBe(8n * U);
    await buy(bob.token, yes, 1);
    expect(await backedMicro(bob.id, no)).toBe(5n * U);
    await sell(bob.token, no, 2);
    expect(await backedMicro(bob.id, no)).toBe(3n * U);
    expect(await backedMicro(bob.id, yes)).toBe(8n * U);
  });

  it('a full sell removes all of it, and buying back does not restore it', async () => {
    const alice = await trader('alice');
    const bob = await trader('bob');
    const [yes] = fx.outcomeIds;
    const a = await comment(alice.token, 'A');
    const b = await comment(alice.token, 'B');
    await buy(bob.token, yes, 20);
    await back(bob.token, a, yes, 12);
    await back(bob.token, b, yes, 8);
    await sell(bob.token, yes, 20);
    expect(await backedMicro(bob.id, yes)).toBe(0n);
    await buy(bob.token, yes, 20);
    expect(await backedMicro(bob.id, yes)).toBe(0n);
    const body = (await list()).body;
    expect(byId(body, a).backing.backers).toBe(0);
    expect(byId(body, b).backing.backers).toBe(0);
  });

  it('another trader’s backing is not touched by my sell', async () => {
    const alice = await trader('alice');
    const bob = await trader('bob');
    const carol = await trader('carol');
    const [yes] = fx.outcomeIds;
    const a = await comment(alice.token, 'A');
    await buy(bob.token, yes, 10);
    await buy(carol.token, yes, 10);
    await back(bob.token, a, yes, 10);
    await back(carol.token, a, yes, 10);
    await sell(bob.token, yes, 10);
    expect(await backedMicro(carol.id, yes)).toBe(10n * U);
    expect(byId((await list()).body, a).backing.backers).toBe(1);
  });

  it('a sell racing a backing never leaves more backed than held', async () => {
    const alice = await trader('alice');
    const bob = await trader('bob');
    const [yes] = fx.outcomeIds;
    const id = await comment(alice.token, 'race');
    for (let i = 0; i < 8; i += 1) {
      await buy(bob.token, yes, 20);
      const results = await Promise.allSettled([
        backComment({ commentId: id, accountId: bob.id, outcomeId: yes, sharesMicro: 20n * U }),
        trade(bob.id, fx.marketId, yes, -15n * U, 0n),
        backComment({ commentId: id, accountId: bob.id, outcomeId: yes, sharesMicro: 5n * U }),
      ]);
      // The sell always goes through; a backing may be refused, never over-allocated.
      expect(results[1].status).toBe('fulfilled');
      const held = await heldMicro(bob.id, yes);
      const backed = await backedMicro(bob.id, yes);
      expect(backed <= held).toBe(true);
      // Clear the stage for the next round.
      await api('DELETE', `/comments/${id}/backing`, { token: bob.token });
      if (held > 0n) await trade(bob.id, fx.marketId, yes, -held, 0n);
    }
  });
});

describe('after settlement', () => {
  it('backings stay, valued at 1 per winning share and 0 otherwise', async () => {
    const alice = await trader('alice');
    const bob = await trader('bob');
    const [yes, no] = fx.outcomeIds;
    const a = await comment(alice.token, 'A');
    const b = await comment(alice.token, 'B');
    await buy(bob.token, yes, 10);
    await buy(bob.token, no, 6);
    await back(bob.token, a, yes, 10);
    await back(bob.token, b, no, 6);
    await settle(fx.marketId, yes, { evidenceUrl: 'https://example.org/decision' });

    const body = (await list(bob.token)).body;
    expect(byId(body, a).backing).toMatchObject({
      totalMicro: units(10),
      byOutcome: [{ outcomeId: yes, sharesMicro: units(10), valueMicro: units(10) }],
    });
    expect(byId(body, b).backing).toMatchObject({
      totalMicro: '0',
      byOutcome: [{ outcomeId: no, sharesMicro: units(6), valueMicro: '0' }],
    });
    // Positions are zeroed, so there is nothing left to allocate.
    expect(body.viewer.available).toEqual([]);
  });
});

describe('sorting', () => {
  it('by relevance: most backing first, ties newest first; newest stays the default', async () => {
    const alice = await trader('alice');
    const bob = await trader('bob');
    const [yes] = fx.outcomeIds;
    const old = await comment(alice.token, 'old');
    const mid = await comment(alice.token, 'mid');
    const tie1 = await comment(alice.token, 'tie1');
    const tie2 = await comment(alice.token, 'tie2');
    await buy(bob.token, yes, 30);
    await back(bob.token, old, yes, 5);
    await back(bob.token, mid, yes, 20);

    const ids = (body: any) => body.comments.map((c: any) => c.id);
    expect(ids((await list()).body)).toEqual([tie2, tie1, mid, old]);
    const rel = await list(undefined, '?sort=relevance');
    expect(rel.status).toBe(200);
    expect(ids(rel.body)).toEqual([mid, old, tie2, tie1]);
    expect(rel.body.nextCursor).toBeNull();
    expect(ids((await list(undefined, '?sort=relevance&limit=1')).body)).toEqual([mid]);

    const page = await list(undefined, '?limit=1');
    expect((await list(undefined, `?sort=relevance&cursor=${page.body.nextCursor}`)).status).toBe(400);
    expect((await list(undefined, '?sort=hot')).status).toBe(400);
  });
});
