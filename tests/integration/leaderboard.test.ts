/* eslint-disable @typescript-eslint/no-explicit-any -- response bodies are checked field by field */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { getDb } from '@/db';
import { accounts, fieldSnapshots, ledgerEntries, markets, wallets } from '@/db/schema';
import { createAccount, createHouse } from '@/server/accounts';
import { createMarket, trade } from '@/server/engine';
import { fieldSnapshot, refreshFieldSnapshot } from '@/server/field-snapshot';
import { invalidateStandings } from '@/server/standings-cache';
import { leaderboardStandings, searchPeople, standingOf } from '@/server/views';
import { defaultMarketKind } from '@/lib/venue';
import { startingBalanceMicro, walletFor } from '@/server/wallets';
import { api } from './api-client';
import { closePool, HOUSE_MICRO, resetDatabase } from './helpers';

/**
 * The leaderboard's institution filter and name search, and fuzzy people
 * search (issue #10). Net worth is set by the signup grant alone, so the
 * order is known without trading. The fixture is built once; every test only
 * reads.
 */

const UNIT = 1_000_000n;
const db = getDb();
/** The venue every fixture wallet is in: the default, so the API needs no `kind`. */
const K = defaultMarketKind();

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
  for (const [handle, displayName, institution, grant, isBot] of people) {
    await createAccount({
      handle,
      displayName,
      institutions: institution ? [institution] : [],
      wallets: [{ kind: K, grantMicro: grant * UNIT }],
      isBot,
    });
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
    const field = await leaderboardStandings({ kind: K, basis: 'net_worth' });
    expect(field.map((r) => [r.handle, r.rank])).toEqual([
      ['ada', 1],
      ['geoff', 2],
      ['ylecun', 3],
      [expect.any(String), 4],
      [expect.any(String), 4],
    ]);
  });

  it('gives a trader’s standing: rank, field size, and the share of the others strictly below', async () => {
    const field = await leaderboardStandings({ kind: K, basis: 'net_worth' });
    const id = (handle: string) => field.find((r) => r.handle === handle)!.accountId;
    expect(standingOf(field, id('ada'), 'net_worth')).toEqual({ rank: 1, fieldSize: 5, percentAhead: 100 });
    expect(standingOf(field, id('ylecun'), 'net_worth')).toEqual({ rank: 3, fieldSize: 5, percentAhead: 50 });
    // Tied last: nobody strictly below.
    expect(standingOf(field, id('bengio'), 'net_worth')).toEqual({ rank: 4, fieldSize: 5, percentAhead: 0 });
    expect(standingOf(field, '00000000-0000-0000-0000-000000000000', 'net_worth')).toBeNull();
  });

  it('ranks one institution among itself', async () => {
    const field = await leaderboardStandings({ kind: K, basis: 'net_worth', institution: 'ETH Zurich' });
    expect(field.map((r) => [r.handle, r.rank])).toEqual([
      ['ada', 1],
      ['ylecun', 2],
    ]);
    expect(await leaderboardStandings({ kind: K, basis: 'net_worth', institution: 'Nowhere' })).toEqual([]);
  });
});

describe('one board per venue', () => {
  it('ranks a venue on its own wallets, and a trade there opens a wallet in it alone', async () => {
    const other = await createMarket({
      slug: 'other-venue',
      kind: 'Other Venue',
      question: 'Will it, elsewhere?',
      outcomes: ['YES', 'NO'],
      closesAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      startingBalanceMicro: 1000n * UNIT,
      expectedTraders: 10,
    });
    expect(await leaderboardStandings({ kind: 'Other Venue', basis: 'net_worth' })).toEqual([]);
    const home = await leaderboardStandings({ kind: K, basis: 'net_worth' });
    const geoff = home.find((r) => r.handle === 'geoff')!;

    // Geoff's first trade there opens a wallet with the starting grant; his
    // wallet here is untouched, and he joins that board alone.
    const fill = await trade(geoff.accountId, other.marketId, other.outcomeIds[0], UNIT, 10n * UNIT);
    expect(fill.balanceAfterMicro).toBe(startingBalanceMicro() - fill.costMicro);
    const there = await leaderboardStandings({ kind: 'Other Venue', basis: 'net_worth' });
    expect(there.map((r) => r.handle)).toEqual(['geoff']);
    expect((await leaderboardStandings({ kind: K, basis: 'net_worth' })).find((r) => r.handle === 'geoff')).toEqual(
      geoff,
    );
    expect(await walletFor(db, geoff.accountId, K)).toMatchObject({ balanceMicro: 500n * UNIT });

    // Leave the shared fixture as the other tests expect it.
    const [{ makerAccountId }] = await db.select().from(markets).where(eq(markets.id, other.marketId));
    await db.delete(markets).where(eq(markets.id, other.marketId));
    const otherWallets = await db.select({ id: wallets.id }).from(wallets).where(eq(wallets.kind, 'Other Venue'));
    await db.delete(ledgerEntries).where(
      inArray(
        ledgerEntries.walletId,
        otherWallets.map((w) => w.id),
      ),
    );
    await db.delete(accounts).where(eq(accounts.id, makerAccountId));
    await db.delete(wallets).where(eq(wallets.kind, 'Other Venue'));
    invalidateStandings();
  });
});

describe('the cached field', () => {
  it('is served from the cache until a write commits', async () => {
    const a = await leaderboardStandings({ kind: K, basis: 'net_worth' });
    expect(await leaderboardStandings({ kind: K, basis: 'net_worth' })).toBe(a);
    expect(Object.isFrozen(a) && Object.isFrozen(a[0])).toBe(true);
    // Concurrent readers share one computation.
    const [x, y] = await Promise.all([
      leaderboardStandings({ kind: K, basis: 'settled_pnl' }),
      leaderboardStandings({ kind: K, basis: 'settled_pnl' }),
    ]);
    expect(x).toBe(y);

    const late = await createAccount({
      handle: 'late',
      displayName: 'Late Comer',
      wallets: [{ kind: K, grantMicro: 700n * UNIT }],
    });
    const b = await leaderboardStandings({ kind: K, basis: 'net_worth' });
    expect(b).not.toBe(a);
    expect(b[0].handle).toBe('late');
    // Leave the shared fixture as the other tests expect it.
    await db.delete(ledgerEntries).where(eq(ledgerEntries.accountId, late.id));
    await db.delete(accounts).where(eq(accounts.id, late.id));
    invalidateStandings();
    expect((await leaderboardStandings({ kind: K, basis: 'net_worth' })).map((r) => r.handle)).not.toContain('late');
  });

  it('never serves a field computed while a write committed', async () => {
    const pending = leaderboardStandings({ kind: K, basis: 'net_worth' });
    invalidateStandings(); // a write commits mid-computation
    const during = await pending;
    expect(await leaderboardStandings({ kind: K, basis: 'net_worth' })).not.toBe(during);
  });

  it('bypasses the cache inside a transaction', async () => {
    const cached = await leaderboardStandings({ kind: K, basis: 'net_worth' });
    await db.transaction(async (tx) => {
      expect(await leaderboardStandings({ kind: K, basis: 'net_worth' }, tx as any)).not.toBe(cached);
    });
  });
});

describe('the shared field snapshot', () => {
  it('draws only accounts that have placed an order', async () => {
    await db.delete(fieldSnapshots);
    const untraded = await refreshFieldSnapshot(K);
    expect(untraded.worthsMicro).toEqual([]);
    expect(untraded.curve).toEqual([]);

    // Two fixture traders buy; the other three still have never traded.
    const market = await createMarket({
      slug: 'field-snapshot',
      kind: K,
      question: 'Will it?',
      outcomes: ['YES', 'NO'],
      closesAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      startingBalanceMicro: 1000n * UNIT,
      expectedTraders: 10,
    });
    const field = await leaderboardStandings({ kind: K, basis: 'net_worth' });
    const idOf = (handle: string) => field.find((r) => r.handle === handle)!.accountId;
    for (const handle of ['ada', 'bengio']) {
      await trade(idOf(handle), market.marketId, market.outcomeIds[0], UNIT, 10n * UNIT);
    }
    const traded = await leaderboardStandings({ kind: K, basis: 'net_worth' });
    const worthOf = (handle: string) => traded.find((r) => r.handle === handle)!.netWorthMicro;
    await db.delete(fieldSnapshots);
    expect((await refreshFieldSnapshot(K)).worthsMicro).toEqual([worthOf('bengio'), worthOf('ada')]);
  });

  it('is computed once, stored, and shared until it is old', async () => {
    await db.delete(fieldSnapshots);
    const first = await fieldSnapshot(K);
    expect(first.worthsMicro).toHaveLength(2);
    expect(first.curve).toHaveLength(120);
    expect(Math.max(...first.curve)).toBeCloseTo(1);
    expect(first.domain[0]).toBeLessThan(300);
    expect(first.domain[1]).toBeGreaterThan(600);
    // Within the max age, the stored row is served as it is.
    expect((await fieldSnapshot(K)).computedAt).toEqual(first.computedAt);
  });

  it('serves a stale snapshot at once and refreshes it in the background', async () => {
    const before = await fieldSnapshot(K);
    process.env.FIELD_SNAPSHOT_MAX_AGE_SECONDS = '0';
    try {
      const served = await fieldSnapshot(K);
      expect(served.computedAt).toEqual(before.computedAt);
      // The refresh it started is shared: await it.
      const fresh = await refreshFieldSnapshot(K);
      expect(fresh.computedAt.getTime()).toBeGreaterThan(before.computedAt.getTime());
    } finally {
      delete process.env.FIELD_SNAPSHOT_MAX_AGE_SECONDS;
    }
    const [row] = await db.select().from(fieldSnapshots);
    expect(row.computedAt.getTime()).toBeGreaterThan(before.computedAt.getTime());
  });

  it('never lets an older computation overwrite a newer snapshot', async () => {
    const future = new Date(Date.now() + 3_600_000);
    await db.update(fieldSnapshots).set({ computedAt: future });
    await refreshFieldSnapshot(K);
    const [row] = await db.select().from(fieldSnapshots);
    expect(row.computedAt).toEqual(future);
    await db.delete(fieldSnapshots);
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
      const page: any = await api(
        'GET',
        `/leaderboard?basis=net_worth&q=o&limit=1${cursor ? `&cursor=${cursor}` : ''}`,
      );
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
