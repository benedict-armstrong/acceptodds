/* eslint-disable @typescript-eslint/no-explicit-any -- response bodies are checked field by field */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAccount, createHouse } from '@/server/accounts';
import { leaderboardStandings, searchPeople } from '@/server/views';
import { api } from './api-client';
import { closePool, HOUSE_MICRO, resetDatabase } from './helpers';

/**
 * The leaderboard's institution filter and name search, and fuzzy people
 * search (issue #10). Net worth is set by the signup grant alone, so the
 * order is known without trading. The fixture is built once; every test only
 * reads.
 */

const UNIT = 1_000_000n;

beforeAll(async () => {
  await resetDatabase();
  process.env.API_RATE_LIMIT_BURST = '1000';
  process.env.API_RATE_LIMIT_PER_SECOND = '1000';
  await createHouse(HOUSE_MICRO);
  const people: [string, string, string | null, bigint, boolean?][] = [
    ['ada', 'Ada Lovelace', 'ETH Zurich', 600n],
    ['geoff', 'Geoffrey Hinton', 'MIT', 500n],
    ['ylecun', 'Yann LeCun', 'ETH Zurich', 400n],
    ['bengio', 'Yoshua Bengio', null, 300n],
    ['botty', 'Bot 100%_sure', null, 300n, true],
  ];
  for (const [handle, displayName, institutionName, grant, isBot] of people) {
    await createAccount({ handle, displayName, institutionName, grantMicro: grant * UNIT, isBot });
  }
}, 60_000);

afterAll(async () => {
  await closePool();
});

describe('searchPeople', () => {
  it('finds by substring of handle or name, case-insensitively', async () => {
    expect((await searchPeople('lecun')).map((p) => p.handle)).toEqual(['ylecun']);
    expect((await searchPeople('GEOFF')).map((p) => p.handle)).toEqual(['geoff']);
    expect((await searchPeople('yo')).map((p) => p.handle)).toEqual(['bengio']);
  });

  it('tolerates a typo', async () => {
    expect((await searchPeople('hintn')).map((p) => p.handle)).toEqual(['geoff']);
    expect((await searchPeople('lovelase')).map((p) => p.handle)).toEqual(['ada']);
  });

  it('never finds the house, and treats LIKE characters as text', async () => {
    expect(await searchPeople('house')).toEqual([]);
    expect((await searchPeople('100%_')).map((p) => p.handle)).toEqual(['botty']);
    // `_` would match any character in "ada" if it were a wildcard.
    expect(await searchPeople('a_a')).toEqual([]);
    expect(await searchPeople('zzzzqq')).toEqual([]);
  });

  it('respects the limit', async () => {
    expect(await searchPeople('o', 2)).toHaveLength(2);
  });
});

describe('leaderboard standings', () => {
  it('ranks the whole field with shared ranks for ties, and no house', async () => {
    const field = await leaderboardStandings({ basis: 'net_worth' });
    expect(field.map((r) => [r.handle, r.rank])).toEqual([
      ['ada', 1],
      ['geoff', 2],
      ['ylecun', 3],
      [expect.any(String), 4],
      [expect.any(String), 4],
    ]);
  });

  it('ranks one institution among itself', async () => {
    const field = await leaderboardStandings({ basis: 'net_worth', institution: 'ETH Zurich' });
    expect(field.map((r) => [r.handle, r.rank])).toEqual([
      ['ada', 1],
      ['ylecun', 2],
    ]);
    expect(await leaderboardStandings({ basis: 'net_worth', institution: 'Nowhere' })).toEqual([]);
  });
});

describe('GET /leaderboard with institution and q', () => {
  it('finds a trader by name, keeping their rank, with the field size', async () => {
    const res = await api('GET', '/leaderboard?basis=net_worth&q=hintn');
    expect(res.status).toBe(200);
    expect(res.body.fieldSize).toBe(5);
    expect(res.body.entries.map((e: any) => [e.handle, e.rank])).toEqual([['geoff', 2]]);
  });

  it('ranks within an institution, and searches within it', async () => {
    const eth = await api('GET', `/leaderboard?basis=net_worth&institution=${encodeURIComponent('ETH Zurich')}`);
    expect(eth.body.fieldSize).toBe(2);
    expect(eth.body.entries.map((e: any) => [e.handle, e.rank])).toEqual([
      ['ada', 1],
      ['ylecun', 2],
    ]);
    const both = await api('GET', `/leaderboard?basis=net_worth&institution=ETH%20Zurich&q=yann`);
    expect(both.body.entries.map((e: any) => [e.handle, e.rank])).toEqual([['ylecun', 2]]);
    const none = await api('GET', `/leaderboard?basis=net_worth&institution=MIT&q=yann`);
    expect(none.body).toMatchObject({ fieldSize: 1, entries: [] });
  });

  it('pages a search with the same cursor', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: any = await api('GET', `/leaderboard?basis=net_worth&q=o&limit=1${cursor ? `&cursor=${cursor}` : ''}`);
      expect(page.status).toBe(200);
      seen.push(...page.body.entries.map((e: any) => e.handle));
      cursor = page.body.nextCursor;
    } while (cursor);
    const all = (await api('GET', '/leaderboard?basis=net_worth&q=o')).body.entries.map((e: any) => e.handle);
    expect(seen).toEqual(all);
    expect(all.length).toBeGreaterThan(1);
  });

  it('treats blank q as absent and refuses an over-long one', async () => {
    const blank = await api('GET', '/leaderboard?basis=net_worth&q=%20');
    expect(blank.body.entries).toHaveLength(5);
    expect((await api('GET', `/leaderboard?q=${'a'.repeat(201)}`)).status).toBe(400);
  });

  it('documents institution and q in the OpenAPI document', async () => {
    const doc = (await api('GET', '/openapi.json')).body;
    const names = doc.paths['/leaderboard'].get.parameters.map((p: any) => p.name);
    expect(names).toEqual(expect.arrayContaining(['institution', 'q']));
  });
});
