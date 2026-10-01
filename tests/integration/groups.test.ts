/* eslint-disable @typescript-eslint/no-explicit-any -- response bodies are checked field by field */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '@/db';
import { groupMembers, groups } from '@/db/schema';
import { MAX_GROUPS_PER_ADMIN } from '@/server/groups';
import { leaderboardStandings, traderInstitutions } from '@/server/views';
import { api, trader } from './api-client';
import { closePool, resetDatabase, seedMarket, STARTING_MICRO } from './helpers';

/** Leaderboard groups (#25): made, joined by invite code, ranked among themselves. */

const db = getDb();

beforeEach(async () => {
  await resetDatabase();
  process.env.API_RATE_LIMIT_BURST = '1000';
  process.env.API_RATE_LIMIT_PER_SECOND = '1000';
  process.env.STARTING_BALANCE_MICRO = STARTING_MICRO.toString();
  await seedMarket(0, 10); // the house
}, 60_000);

afterAll(async () => {
  await closePool();
});

async function made(token: string, name = 'Reading group', description?: string) {
  const res = await api('POST', '/groups', { token, body: { name, description } });
  expect(res.status).toBe(201);
  return res.body;
}

describe('groups', () => {
  it('makes a group with its maker as admin and only member, and shows the code only to members', async () => {
    const a = await trader('alice', ['read']);
    const g = await made(a.token, '  Hinton lab  ', 'Mostly Boltzmann machines');
    expect(g).toMatchObject({
      name: 'Hinton lab',
      description: 'Mostly Boltzmann machines',
      memberCount: 1,
      role: 'admin',
      members: [{ handle: 'alice', role: 'admin', institutions: ['Test University'] }],
    });
    expect(g.inviteCode).toMatch(/^[\w-]{16}$/);

    const anon = await api('GET', `/groups/${g.id}`);
    expect(anon.status).toBe(200);
    expect(anon.body.role).toBeNull();
    expect(anon.body.inviteCode).toBeNull();
    expect(anon.body.members.map((m: any) => m.handle)).toEqual(['alice']);

    const mine = await api('GET', '/me/groups', { token: a.token });
    expect(mine.body.groups).toEqual([
      {
        id: g.id,
        name: 'Hinton lab',
        description: 'Mostly Boltzmann machines',
        memberCount: 1,
        role: 'admin',
        inviteCode: g.inviteCode,
      },
    ]);
  });

  it('joins by invite code, idempotently, and ranks the group among itself', async () => {
    const a = await trader('alice', ['read']);
    const b = await trader('bob', ['read'], { grantMicro: 2n * STARTING_MICRO });
    await trader('carol', ['read']);
    const g = await made(a.token);

    expect((await api('POST', '/groups/join', { token: b.token, body: { inviteCode: 'nope' } })).status).toBe(404);
    const joined = await api('POST', '/groups/join', { token: b.token, body: { inviteCode: g.inviteCode } });
    expect(joined.status).toBe(200);
    expect(joined.body).toMatchObject({ role: 'member', memberCount: 2, inviteCode: g.inviteCode });
    expect(joined.body.members.map((m: any) => [m.handle, m.role])).toEqual([
      ['alice', 'admin'],
      ['bob', 'member'],
    ]);
    const again = await api('POST', '/groups/join', { token: b.token, body: { inviteCode: g.inviteCode } });
    expect(again.body.memberCount).toBe(2);

    const board = await api('GET', `/leaderboard?basis=net_worth&group=${g.id}`);
    expect(board.status).toBe(200);
    expect(board.body.fieldSize).toBe(2);
    expect(board.body.entries.map((e: any) => [e.rank, e.handle])).toEqual([
      [1, 'bob'],
      [2, 'alice'],
    ]);
    // Combined with an institution, both filters hold.
    const both = await leaderboardStandings({ basis: 'net_worth', group: g.id, institution: 'Nowhere' });
    expect(both).toEqual([]);
  });

  it('lets only the admin rename, rotate the code, remove members and delete', async () => {
    const a = await trader('alice', ['read']);
    const b = await trader('bob', ['read']);
    const c = await trader('carol', ['read']);
    const g = await made(a.token);
    for (const t of [b, c]) await api('POST', '/groups/join', { token: t.token, body: { inviteCode: g.inviteCode } });

    expect((await api('PATCH', `/groups/${g.id}`, { token: b.token, body: { name: 'Mine' } })).status).toBe(403);
    const renamed = await api('PATCH', `/groups/${g.id}`, {
      token: a.token,
      body: { name: 'Journal club', description: ' ' },
    });
    expect(renamed.body).toMatchObject({ name: 'Journal club', description: null });

    expect((await api('POST', `/groups/${g.id}/invite`, { token: b.token })).status).toBe(403);
    const rotated = await api('POST', `/groups/${g.id}/invite`, { token: a.token });
    expect(rotated.body.inviteCode).not.toBe(g.inviteCode);
    const d = await trader('dave', ['read']);
    expect((await api('POST', '/groups/join', { token: d.token, body: { inviteCode: g.inviteCode } })).status).toBe(
      404,
    );

    // A member removes nobody but themselves; the admin anyone but themselves.
    expect((await api('DELETE', `/groups/${g.id}/members/carol`, { token: b.token })).status).toBe(403);
    expect((await api('DELETE', `/groups/${g.id}/members/bob`, { token: b.token })).status).toBe(204);
    expect((await api('DELETE', `/groups/${g.id}/members/bob`, { token: b.token })).status).toBe(204);
    expect((await api('DELETE', `/groups/${g.id}/members/carol`, { token: a.token })).status).toBe(204);
    const left = await api('DELETE', `/groups/${g.id}/members/alice`, { token: a.token });
    expect(left.status).toBe(409);
    expect(left.body.error.code).toBe('group_admin');
    expect((await api('GET', `/groups/${g.id}`)).body.memberCount).toBe(1);

    expect((await api('DELETE', `/groups/${g.id}`, { token: b.token })).status).toBe(403);
    expect((await api('DELETE', `/groups/${g.id}`, { token: a.token })).status).toBe(204);
    expect((await api('GET', `/groups/${g.id}`)).status).toBe(404);
    expect(await db.select().from(groupMembers)).toEqual([]);
  });

  it('caps the groups one admin runs', async () => {
    const a = await trader('alice', ['read']);
    await db.insert(groups).values(
      Array.from({ length: MAX_GROUPS_PER_ADMIN }, (_, i) => ({
        name: `g${i}`,
        adminAccountId: a.id,
        inviteCode: `code-${i}`,
      })),
    );
    const res = await api('POST', '/groups', { token: a.token, body: { name: 'one more' } });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('too_many_groups');
  });

  it('needs a credential to write, validates names, and 404s an unknown group', async () => {
    expect((await api('POST', '/groups', { body: { name: 'x' } })).status).toBe(401);
    const a = await trader('alice', ['read']);
    expect((await api('POST', '/groups', { token: a.token, body: { name: '   ' } })).status).toBe(400);
    expect((await api('POST', '/groups', { token: a.token, body: { name: 'x'.repeat(81) } })).status).toBe(400);
    expect((await api('GET', '/groups/00000000-0000-4000-8000-000000000000')).status).toBe(404);
    expect((await api('GET', '/groups/not-a-uuid')).status).toBe(400);
  });

  it('lists every institution with traders, for the board picker', async () => {
    await trader('alice', ['read']);
    await trader('bob', ['read']);
    await trader('carol', ['read'], { verified: false });
    expect(await traderInstitutions()).toEqual([{ name: 'Test University', traders: 2 }]);
  });
});
