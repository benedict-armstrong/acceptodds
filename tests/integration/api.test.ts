/* eslint-disable @typescript-eslint/no-explicit-any -- response bodies are checked field by field */
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { validate } from '@readme/openapi-parser';
import { and, eq, sql } from 'drizzle-orm';
import { getDb } from '@/db';
import { accounts, events, ledgerEntries, markets, orders } from '@/db/schema';
import { liquidityFor } from '@/lib/lmsr';
import { microToFloat } from '@/lib/money';
import { reconcileBalances } from '@/server/accounts';
import { createMarket } from '@/server/engine';
import { revokeToken } from '@/server/tokens';
import { api, ROUTE_PATTERNS, trader } from './api-client';
import { closePool, resetDatabase, seedMarket, STARTING_MICRO, type Fixture } from './helpers';

const db = getDb();

let fx: Fixture;

beforeEach(async () => {
  await resetDatabase();
  process.env.API_RATE_LIMIT_BURST = '1000';
  process.env.API_RATE_LIMIT_PER_SECOND = '1000';
  process.env.STARTING_BALANCE_MICRO = STARTING_MICRO.toString();
  fx = await seedMarket(0, 10);
}, 60_000);

afterAll(async () => {
  await closePool();
});

/** Let fire-and-forget event inserts land. */
async function settleEvents(): Promise<void> {
  await new Promise((r) => setTimeout(r, 150));
}

async function buy(token: string, outcomeId: string, sharesMicro: bigint, marketId = fx.marketId) {
  const q = await api('POST', `/markets/${marketId}/quote`, { body: { outcomeId, sharesMicro: sharesMicro.toString() } });
  expect(q.status).toBe(200);
  return api('POST', `/markets/${marketId}/orders`, {
    token,
    body: { outcomeId, sharesMicro: sharesMicro.toString(), maxCostMicro: q.body.costMicro },
  });
}

// ---------------------------------------------------------------------------
// the contract
// ---------------------------------------------------------------------------

describe('OpenAPI', () => {
  it('serves a document that validates as OpenAPI 3.1', async () => {
    const res = await api('GET', '/openapi.json');
    expect(res.status).toBe(200);
    expect(res.body.openapi).toBe('3.1.0');
    const result = await validate(structuredClone(res.body));
    expect(result.valid ? [] : result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('documents every route file under app/api/v1, and nothing else', async () => {
    const root = join(process.cwd(), 'src/app/api/v1');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (name === 'route.ts') files.push(relative(root, dir));
      }
    };
    walk(root);
    const routes = files
      .filter((f) => f !== 'openapi.json' && f !== '[...rest]')
      .map((f) => '/' + f.replace(/\[(\w+)\]/g, '{$1}'))
      .sort();

    const doc = (await api('GET', '/openapi.json')).body;
    expect(Object.keys(doc.paths).sort()).toEqual(routes);
    // …and the in-process test router knows about all of them.
    expect(ROUTE_PATTERNS.filter((p) => p !== '/openapi.json').map((p) => p.replace(/\[(\w+)\]/g, '{$1}')).sort()).toEqual(routes);
  });
});

describe('every response', () => {
  it('is Cache-Control: no-store, including errors', async () => {
    for (const res of [
      await api('GET', '/markets'),
      await api('GET', `/markets/${fx.marketId}`),
      await api('GET', '/markets/nope'),
      await api('GET', '/me'),
      await api('GET', '/no/such/thing'),
    ]) {
      expect(res.headers.get('cache-control')).toBe('no-store');
    }
  });

  it('uses the one error shape, including for unknown routes and wrong methods', async () => {
    const cases = [
      [await api('GET', '/no/such/thing'), 404, 'not_found'],
      [await api('DELETE', '/markets'), 405, 'method_not_allowed'],
      [await api('GET', `/markets/${fx.marketId}/quote`), 405, 'method_not_allowed'],
      [await api('GET', '/markets/does-not-exist'), 404, 'not_found'],
    ] as const;
    for (const [res, status, code] of cases) {
      expect(res.status).toBe(status);
      expect(res.body).toEqual({ error: { code, message: expect.any(String) } });
    }
  });
});

// ---------------------------------------------------------------------------
// public reads
// ---------------------------------------------------------------------------

describe('markets', () => {
  it('lists with keyset pagination and no repeats', async () => {
    for (const slug of ['m-a', 'm-b', 'm-c']) {
      await createMarket({
        slug,
        question: slug,
        outcomes: ['YES', 'NO'],
        closesAt: new Date(Date.now() + 86_400_000),
        startingBalanceMicro: STARTING_MICRO,
        expectedTraders: 10,
        kind: slug === 'm-b' ? 'special' : 'binary',
      });
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const res: any = await api('GET', `/markets?limit=1${cursor ? `&cursor=${cursor}` : ''}`);
      expect(res.status).toBe(200);
      expect(res.body.markets).toHaveLength(1);
      seen.push(res.body.markets[0].slug);
      cursor = res.body.nextCursor;
    } while (cursor);
    expect(seen).toEqual(['m-c', 'm-b', 'm-a', 'concurrency']);

    const special = await api('GET', '/markets?kind=special');
    expect(special.body.markets.map((m: any) => m.slug)).toEqual(['m-b']);

    const bad = await api('GET', '/markets?cursor=garbage');
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('validation_error');
  });

  it('serves the board by id or slug, with b and prices', async () => {
    const byId = await api('GET', `/markets/${fx.marketId}`);
    const bySlug = await api('GET', '/markets/concurrency');
    expect(byId.status).toBe(200);
    expect(bySlug.body).toEqual(byId.body);
    expect(byId.body.b).toBe(fx.b);
    expect(byId.body.outcomes.map((o: any) => o.price)).toEqual([0.5, 0.5]);
    expect(byId.body.volumeMicro).toBe('0');
  });

  it('quotes without writing, and without auth', async () => {
    const res = await api('POST', `/markets/${fx.marketId}/quote`, {
      body: { outcomeId: fx.outcomeIds[0], sharesMicro: 10_000_000 },
    });
    expect(res.status).toBe(200);
    expect(BigInt(res.body.costMicro)).toBeGreaterThan(5_000_000n);
    expect(res.body.priceAfter).toBeGreaterThan(res.body.priceBefore);
    expect(await db.select().from(orders)).toEqual([]);
  });

  it('rejects malformed quote bodies with validation_error', async () => {
    for (const body of [
      { outcomeId: 'nope', sharesMicro: '1' },
      { outcomeId: fx.outcomeIds[0], sharesMicro: 1.5 },
      { outcomeId: fx.outcomeIds[0], sharesMicro: '1e6' },
      { outcomeId: fx.outcomeIds[0] },
    ]) {
      const res = await api('POST', `/markets/${fx.marketId}/quote`, { body });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('validation_error');
    }
    const notJson = await api('POST', `/markets/${fx.marketId}/quote`, { rawBody: '{' });
    expect(notJson.body.error.code).toBe('validation_error');

    const zero = await api('POST', `/markets/${fx.marketId}/quote`, {
      body: { outcomeId: fx.outcomeIds[0], sharesMicro: '0' },
    });
    expect(zero.status).toBe(400);
    expect(zero.body.error.code).toBe('invalid_size');
  });
});

describe('the public tape', () => {
  it('carries no account identities', async () => {
    const t = await trader('tape-trader');
    const fill = await api('POST', `/markets/${fx.marketId}/orders`, {
      token: t.token,
      headers: { 'Idempotency-Key': 'secret-key-123' },
      body: { outcomeId: fx.outcomeIds[0], sharesMicro: '1000000', maxCostMicro: '1000000' },
    });
    expect(fill.status).toBe(201);

    const tape = await api('GET', `/markets/${fx.marketId}/orders`);
    expect(tape.status).toBe(200);
    expect(tape.body.orders).toHaveLength(1);
    expect(Object.keys(tape.body.orders[0]).sort()).toEqual(
      ['costMicro', 'createdAt', 'id', 'outcomeId', 'priceAfter', 'priceBefore', 'sharesMicro'].sort(),
    );
    const raw = JSON.stringify(tape.body);
    expect(raw).not.toContain(t.id);
    expect(raw).not.toContain('tape-trader');
    expect(raw).not.toContain('secret-key-123');
  });

  it('pages newest first without repeats', async () => {
    const t = await trader('pager');
    for (let i = 0; i < 5; i += 1) await buy(t.token, fx.outcomeIds[i % 2], 1_000_000n);
    const ids: string[] = [];
    let cursor: string | null = null;
    do {
      const res: any = await api('GET', `/markets/${fx.marketId}/orders?limit=2${cursor ? `&cursor=${cursor}` : ''}`);
      ids.push(...res.body.orders.map((o: any) => o.id));
      cursor = res.body.nextCursor;
    } while (cursor);
    const all = await api('GET', `/markets/${fx.marketId}/orders?limit=200`);
    expect(ids).toEqual(all.body.orders.map((o: any) => o.id));
    expect(new Set(ids).size).toBe(5);
  });
});

describe('price history', () => {
  it('is one point per fill plus the opening, and pages to the same series', async () => {
    const t = await trader('historian');
    for (let i = 0; i < 5; i += 1) await buy(t.token, fx.outcomeIds[i % 2], BigInt(1 + i) * 3_000_000n);

    const all = await api('GET', `/markets/${fx.marketId}/history?limit=200`);
    expect(all.body.points).toHaveLength(6);
    expect(all.body.points[0].prices).toEqual([0.5, 0.5]);

    const board = await api('GET', `/markets/${fx.marketId}`);
    const last = all.body.points[5].prices;
    board.body.outcomes.forEach((o: any) => expect(last[o.ordinal]).toBeCloseTo(o.price, 12));

    const paged: any[] = [];
    let cursor: string | null = null;
    do {
      const res: any = await api('GET', `/markets/${fx.marketId}/history?limit=2${cursor ? `&cursor=${cursor}` : ''}`);
      paged.push(...res.body.points);
      cursor = res.body.nextCursor;
    } while (cursor);
    expect(paged).toEqual(all.body.points);
  });
});

// ---------------------------------------------------------------------------
// auth, scopes and rate limits
// ---------------------------------------------------------------------------

describe('authentication', () => {
  it('401s a missing, malformed, unknown or revoked token on a protected route', async () => {
    const t = await trader('authy');
    expect((await api('GET', '/me', { token: t.token })).status).toBe(200);

    const missing = await api('GET', '/me');
    expect(missing.status).toBe(401);
    expect(missing.body.error.code).toBe('unauthorized');

    const malformed = await api('GET', '/me', { headers: { authorization: 'Basic abc' } });
    expect(malformed.body.error.code).toBe('unauthorized');

    // Right prefix, wrong secret: found by prefix, refused by the hash compare.
    const forged = t.token.slice(0, 16) + 'A'.repeat(t.token.length - 16);
    expect((await api('GET', '/me', { token: forged })).status).toBe(401);

    await revokeToken(t.tokenId);
    const revoked = await api('GET', '/me', { token: t.token });
    expect(revoked.status).toBe(401);
    expect(revoked.body.error.code).toBe('unauthorized');
  });

  it('401s a bad token on a public route rather than silently serving it anonymously', async () => {
    const res = await api('GET', '/markets', { token: 'pm_live_nope' });
    expect(res.status).toBe(401);
    expect((await api('GET', '/markets')).status).toBe(200);
  });

  it('stores only a hash of the token', async () => {
    const t = await trader('hashy');
    const rows = await db.execute(sql`select * from api_tokens`);
    expect(JSON.stringify(rows.rows)).not.toContain(t.token);
  });

  it('never mints a token from a token: /me/tokens is session-only', async () => {
    const t = await trader('minter', ['read', 'trade', 'admin']);
    const res = await api('POST', '/me/tokens', { token: t.token, body: { name: 'x', scopes: ['read'] } });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('session_required');
    expect((await api('POST', '/me/tokens', { body: { name: 'x', scopes: ['read'] } })).status).toBe(401);
  });
});

describe('scopes', () => {
  it('a read token can read but not trade or administer', async () => {
    const t = await trader('reader', ['read']);
    expect((await api('GET', '/me', { token: t.token })).status).toBe(200);
    expect((await api('GET', '/me/portfolio', { token: t.token })).status).toBe(200);

    const order = await api('POST', `/markets/${fx.marketId}/orders`, {
      token: t.token,
      body: { outcomeId: fx.outcomeIds[0], sharesMicro: '1000000', maxCostMicro: '1000000' },
    });
    expect(order.status).toBe(403);
    expect(order.body.error).toMatchObject({ code: 'forbidden', details: { requiredScope: 'trade' } });
    expect(await db.select().from(orders)).toEqual([]);

    const close = await api('POST', `/markets/${fx.marketId}/close`, { token: t.token });
    expect(close.status).toBe(403);
  });

  it('a trade-only token can trade but not read /me or administer', async () => {
    const t = await trader('trade-only', ['trade']);
    expect((await buy(t.token, fx.outcomeIds[0], 1_000_000n)).status).toBe(201);
    expect((await api('GET', '/me', { token: t.token })).status).toBe(403);
    const create = await api('POST', '/markets', {
      token: t.token,
      body: {
        slug: 'nope',
        question: 'q',
        outcomes: ['A', 'B'],
        closesAt: new Date(Date.now() + 86_400_000).toISOString(),
        expectedTraders: 10,
      },
    });
    expect(create.status).toBe(403);
  });

  it('admin does not imply trade', async () => {
    const t = await trader('admin-only', ['admin']);
    const res = await buy(t.token, fx.outcomeIds[0], 1_000_000n);
    expect(res.status).toBe(403);
  });
});

describe('rate limiting', () => {
  it('429s past the burst with Retry-After and X-RateLimit headers', async () => {
    process.env.API_RATE_LIMIT_BURST = '3';
    process.env.API_RATE_LIMIT_PER_SECOND = '0.01';
    const t = await trader('chatty', ['read']);

    const ok = [];
    for (let i = 0; i < 3; i += 1) ok.push(await api('GET', '/me', { token: t.token }));
    expect(ok.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(ok.map((r) => r.headers.get('x-ratelimit-remaining'))).toEqual(['2', '1', '0']);
    expect(ok[0].headers.get('x-ratelimit-limit')).toBe('3');

    const limited = await api('GET', '/me', { token: t.token });
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('rate_limited');
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(limited.headers.get('x-ratelimit-remaining')).toBe('0');

    // Per token, not per account or global: a second token is unaffected.
    const other = await trader('quiet', ['read']);
    expect((await api('GET', '/me', { token: other.token })).status).toBe(200);
    // Anonymous reads are the edge's job, not this bucket's.
    expect((await api('GET', '/markets')).status).toBe(200);
  });

  it('holds under concurrency: exactly `burst` of a simultaneous flood get through', async () => {
    process.env.API_RATE_LIMIT_BURST = '5';
    process.env.API_RATE_LIMIT_PER_SECOND = '0.001';
    const t = await trader('flood', ['read']);
    const results = await Promise.all(Array.from({ length: 20 }, () => api('GET', '/me', { token: t.token })));
    expect(results.filter((r) => r.status === 200)).toHaveLength(5);
    expect(results.filter((r) => r.status === 429)).toHaveLength(15);
  });

  it('refills over time', async () => {
    process.env.API_RATE_LIMIT_BURST = '1';
    process.env.API_RATE_LIMIT_PER_SECOND = '20';
    const t = await trader('patient', ['read']);
    expect((await api('GET', '/me', { token: t.token })).status).toBe(200);
    expect((await api('GET', '/me', { token: t.token })).status).toBe(429);
    await new Promise((r) => setTimeout(r, 120));
    expect((await api('GET', '/me', { token: t.token })).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// trading
// ---------------------------------------------------------------------------

describe('orders', () => {
  it('fills a buy and a sell on the same endpoint; selling is negative shares', async () => {
    const t = await trader('round-tripper');
    const bought = await buy(t.token, fx.outcomeIds[0], 10_000_000n);
    expect(bought.status).toBe(201);
    expect(bought.body.positionAfterMicro).toBe('10000000');

    const exit = await api('POST', `/markets/${fx.marketId}/quote`, {
      body: { outcomeId: fx.outcomeIds[0], sharesMicro: '-10000000' },
    });
    const sold = await api('POST', `/markets/${fx.marketId}/orders`, {
      token: t.token,
      body: { outcomeId: fx.outcomeIds[0], sharesMicro: '-10000000', maxCostMicro: exit.body.costMicro },
    });
    expect(sold.status).toBe(201);
    expect(BigInt(sold.body.costMicro)).toBeLessThan(0n);
    expect(sold.body.positionAfterMicro).toBe('0');
    // The round trip costs the trader something, never pays them (§1.1).
    expect(BigInt(sold.body.balanceAfterMicro)).toBeLessThan(STARTING_MICRO);
    expect(await reconcileBalances(db)).toEqual([]);
  });

  it('maps engine refusals to stable codes', async () => {
    const t = await trader('poor', ['read', 'trade'], { grantMicro: 1_000_000n });
    const outcomeId = fx.outcomeIds[0];
    const post = (body: object, token = t.token) =>
      api('POST', `/markets/${fx.marketId}/orders`, { token, body: { outcomeId, ...body } });

    const broke = await post({ sharesMicro: '100000000', maxCostMicro: '1000000000' });
    expect(broke.status).toBe(409);
    expect(broke.body.error.code).toBe('insufficient_balance');

    const slip = await post({ sharesMicro: '1000000', maxCostMicro: '1' });
    expect(slip.status).toBe(409);
    expect(slip.body.error).toMatchObject({ code: 'slippage_exceeded', details: { maxCostMicro: '1' } });

    const naked = await post({ sharesMicro: '-1000000', maxCostMicro: '0' });
    expect(naked.status).toBe(409);
    expect(naked.body.error.code).toBe('insufficient_shares');

    const wrongOutcome = await api('POST', `/markets/${fx.marketId}/orders`, {
      token: t.token,
      body: { outcomeId: '00000000-0000-4000-8000-000000000000', sharesMicro: '1', maxCostMicro: '10' },
    });
    expect(wrongOutcome.status).toBe(404);
    expect(wrongOutcome.body.error.code).toBe('not_found');

    const noBody = await api('POST', `/markets/${fx.marketId}/orders`, { token: t.token, body: {} });
    expect(noBody.body.error.code).toBe('validation_error');

    expect(await db.select().from(orders)).toEqual([]);
  });

  it('refuses a market past closes_at with market_closed, and a closed market with market_not_open', async () => {
    const t = await trader('late');
    const expired = await createMarket({
      slug: 'expired',
      question: 'q',
      outcomes: ['A', 'B'],
      closesAt: new Date(Date.now() - 1000),
      startingBalanceMicro: STARTING_MICRO,
      expectedTraders: 10,
    });
    const late = await buy(t.token, expired.outcomeIds[0], 1_000_000n, expired.marketId);
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('market_closed');

    const admin = await trader('closer', ['admin']);
    const closed = await api('POST', `/markets/${fx.marketId}/close`, { token: admin.token });
    expect(closed.status).toBe(200);
    expect(closed.body.status).toBe('closed');
    const refused = await buy(t.token, fx.outcomeIds[0], 1_000_000n);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('market_not_open');
  });
});

describe('Idempotency-Key over HTTP', () => {
  it('a retry returns the original fill and trades once', async () => {
    const t = await trader('retrier');
    const send = () =>
      api('POST', `/markets/${fx.marketId}/orders`, {
        token: t.token,
        headers: { 'Idempotency-Key': 'order-1' },
        body: { outcomeId: fx.outcomeIds[0], sharesMicro: '5000000', maxCostMicro: '10000000' },
      });
    const first = await send();
    const second = await send();
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(first.body.replayed).toBe(false);
    expect(second.body.replayed).toBe(true);
    expect(second.headers.get('idempotent-replayed')).toBe('true');
    expect(second.body.orderId).toBe(first.body.orderId);
    expect(second.body.costMicro).toBe(first.body.costMicro);

    expect(await db.select().from(orders)).toHaveLength(1);
    const [acct] = await db.select().from(accounts).where(eq(accounts.id, t.id));
    expect(acct.balanceMicro).toBe(STARTING_MICRO - BigInt(first.body.costMicro));
  });

  it('racing retries still trade once', async () => {
    const t = await trader('racer');
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        api('POST', `/markets/${fx.marketId}/orders`, {
          token: t.token,
          headers: { 'Idempotency-Key': 'race-1' },
          body: { outcomeId: fx.outcomeIds[1], sharesMicro: '2000000', maxCostMicro: '10000000' },
        }),
      ),
    );
    expect(results.map((r) => r.status)).toEqual(Array(8).fill(201));
    expect(new Set(results.map((r) => r.body.orderId)).size).toBe(1);
    expect(results.filter((r) => !r.body.replayed)).toHaveLength(1);
    expect(await db.select().from(orders)).toHaveLength(1);
    expect(await reconcileBalances(db)).toEqual([]);
  });

  it('refuses a reused key for a different order rather than reporting a fill that never happened', async () => {
    const t = await trader('reuser');
    const post = (sharesMicro: string) =>
      api('POST', `/markets/${fx.marketId}/orders`, {
        token: t.token,
        headers: { 'Idempotency-Key': 'same' },
        body: { outcomeId: fx.outcomeIds[0], sharesMicro, maxCostMicro: '100000000' },
      });
    expect((await post('1000000')).status).toBe(201);
    const reused = await post('2000000');
    expect(reused.status).toBe(409);
    expect(reused.body.error.code).toBe('idempotency_key_reused');
    expect(await db.select().from(orders)).toHaveLength(1);
  });

  it('is scoped per account: two accounts may use the same key', async () => {
    const a = await trader('key-a');
    const b = await trader('key-b');
    for (const t of [a, b]) {
      const res = await api('POST', `/markets/${fx.marketId}/orders`, {
        token: t.token,
        headers: { 'Idempotency-Key': 'shared' },
        body: { outcomeId: fx.outcomeIds[0], sharesMicro: '1000000', maxCostMicro: '10000000' },
      });
      expect(res.body.replayed).toBe(false);
    }
    expect(await db.select().from(orders)).toHaveLength(2);
  });

  it('validates the header', async () => {
    const t = await trader('bad-key');
    const res = await api('POST', `/markets/${fx.marketId}/orders`, {
      token: t.token,
      headers: { 'Idempotency-Key': 'x'.repeat(256) },
      body: { outcomeId: fx.outcomeIds[0], sharesMicro: '1000000', maxCostMicro: '10000000' },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_error');
  });
});

// ---------------------------------------------------------------------------
// me
// ---------------------------------------------------------------------------

describe('portfolio (§1.1)', () => {
  it('reports mark and quoted exit value as separate, differently named fields', async () => {
    const t = await trader('holder');
    await buy(t.token, fx.outcomeIds[0], 50_000_000n);

    const res = await api('GET', '/me/portfolio', { token: t.token });
    expect(res.status).toBe(200);
    const [h] = res.body.holdings;
    expect(h.sharesMicro).toBe('50000000');
    expect(h.marketStatus).toBe('open');
    const mark = BigInt(h.markMicro);
    const exit = BigInt(h.quotedExitMicro);
    // Two different numbers, and the sale price is the smaller.
    expect(exit).toBeLessThan(mark);

    // Exactly what a real sell-everything quote says.
    const q = await api('POST', `/markets/${fx.marketId}/quote`, {
      body: { outcomeId: fx.outcomeIds[0], sharesMicro: '-50000000' },
    });
    expect(h.quotedExitMicro).toBe((-BigInt(q.body.costMicro)).toString());

    // Mid-market net worth is present only labelled, next to a caveat, and
    // nowhere at the top level where it could be read as a score.
    expect(Object.keys(res.body).sort()).toEqual(['accountId', 'balanceMicro', 'holdings', 'unsettledValuation']);
    expect(res.body.unsettledValuation.caveat).toMatch(/not a score/i);
    expect(BigInt(res.body.unsettledValuation.liquidationValueMicro)).toBeLessThan(
      BigInt(res.body.unsettledValuation.midMarketNetWorthMicro),
    );
  });

  it('/me/orders lists own fills only, with the idempotency key', async () => {
    const t = await trader('mine');
    const other = await trader('theirs');
    await buy(other.token, fx.outcomeIds[0], 1_000_000n);
    await api('POST', `/markets/${fx.marketId}/orders`, {
      token: t.token,
      headers: { 'Idempotency-Key': 'k1' },
      body: { outcomeId: fx.outcomeIds[1], sharesMicro: '1000000', maxCostMicro: '10000000' },
    });
    const res = await api('GET', '/me/orders', { token: t.token });
    expect(res.body.orders).toHaveLength(1);
    expect(res.body.orders[0]).toMatchObject({ marketId: fx.marketId, idempotencyKey: 'k1' });
  });

  it('/me returns the account and balance', async () => {
    const t = await trader('me-me', ['read'], { isBot: true });
    const res = await api('GET', '/me', { token: t.token });
    expect(res.body).toMatchObject({
      id: t.id,
      handle: 'me-me',
      isBot: true,
      balanceMicro: STARTING_MICRO.toString(),
      auth: { method: 'token', scopes: ['read'] },
    });
  });
});

// ---------------------------------------------------------------------------
// leaderboard and profiles (§1.2)
// ---------------------------------------------------------------------------

describe('leaderboard (§1.2)', () => {
  it('ignores open markets entirely, however good a trader’s mid-market net worth looks', async () => {
    const pumper = await trader('pumper');
    // Buy a lot: the trader's own price impact inflates their mark.
    await buy(pumper.token, fx.outcomeIds[0], 400_000_000n);
    const pf = await api('GET', '/me/portfolio', { token: pumper.token });
    expect(BigInt(pf.body.holdings[0].markMicro)).toBeGreaterThan(0n);

    const board = await api('GET', '/leaderboard');
    expect(board.status).toBe(200);
    expect(board.body.basis).toBe('settled_pnl');
    expect(board.body.entries).toEqual([]);
  });

  it('ranks on settled P&L only, and excludes house accounts', async () => {
    const admin = await trader('settler', ['admin']);
    const winner = await trader('winner');
    const loser = await trader('loser');
    const pumper = await trader('pumper');

    await buy(winner.token, fx.outcomeIds[0], 20_000_000n);
    await buy(loser.token, fx.outcomeIds[1], 20_000_000n);

    // A second, still-open market where `pumper` is hugely "up" on the mark.
    const open = await createMarket({
      slug: 'still-open',
      question: 'q',
      outcomes: ['A', 'B'],
      closesAt: new Date(Date.now() + 86_400_000),
      startingBalanceMicro: STARTING_MICRO,
      expectedTraders: 1,
    });
    await buy(pumper.token, open.outcomeIds[0], 300_000_000n, open.marketId);
    await buy(winner.token, open.outcomeIds[1], 1_000_000n, open.marketId);

    const settled = await api('POST', `/markets/${fx.marketId}/settle`, {
      token: admin.token,
      body: { winningOutcomeId: fx.outcomeIds[0], evidenceUrl: 'https://example.org/decision' },
    });
    expect(settled.status).toBe(200);

    const res = await api('GET', '/leaderboard');
    const entries = res.body.entries;
    expect(entries.map((e: any) => e.handle)).toEqual(['winner', 'loser']);
    expect(entries.map((e: any) => e.rank)).toEqual([1, 2]);
    expect(BigInt(entries[0].settledPnlMicro)).toBeGreaterThan(0n);
    expect(BigInt(entries[1].settledPnlMicro)).toBeLessThan(0n);
    expect(entries[0].settledMarkets).toBe(1);

    // The winner's settled P&L is exactly payout minus cost on the settled
    // market — the open market's trade is not in it.
    const [{ costMicro: cost }] = await db
      .select()
      .from(orders)
      .where(and(eq(orders.accountId, winner.id), eq(orders.marketId, fx.marketId)));
    expect(entries[0].settledPnlMicro).toBe((20_000_000n - cost).toString());

    // Pagination walks the same order.
    const p1 = await api('GET', '/leaderboard?limit=1');
    const p2 = await api('GET', `/leaderboard?limit=1&cursor=${p1.body.nextCursor}`);
    expect([p1.body.entries[0].handle, p2.body.entries[0].handle]).toEqual(['winner', 'loser']);
    expect(p2.body.nextCursor).toBeNull();
  });

  it('public profiles show the settled record and no balance', async () => {
    await trader('someone', ['read'], { isBot: true });
    const res = await api('GET', '/accounts/someone');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      handle: 'someone',
      isBot: true,
      settledRecord: { settledPnlMicro: '0', settledMarkets: 0 },
    });
    expect(JSON.stringify(res.body)).not.toMatch(/balance/i);
    expect((await api('GET', '/accounts/house')).status).toBe(404);
    expect((await api('GET', '/accounts/nobody')).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// admin
// ---------------------------------------------------------------------------

describe('admin', () => {
  it('creates a market with b computed once from the field size, and debits the house', async () => {
    const admin = await trader('creator', ['admin']);
    const [houseBefore] = await db.select().from(accounts).where(eq(accounts.handle, 'house'));
    const res = await api('POST', '/markets', {
      token: admin.token,
      body: {
        slug: 'new-market',
        question: 'Will it?',
        outcomes: ['A', 'B', 'C'],
        closesAt: new Date(Date.now() + 86_400_000).toISOString(),
        expectedTraders: 40,
        kind: 'opaque-kind',
        resolutionSource: 'whatever the client says',
      },
    });
    expect(res.status).toBe(201);
    expect(res.body.market.b).toBe(liquidityFor(microToFloat(STARTING_MICRO), 40, 3));
    expect(res.body.market.kind).toBe('opaque-kind');
    expect(res.body.market.outcomes.map((o: any) => o.label)).toEqual(['A', 'B', 'C']);

    const [houseAfter] = await db.select().from(accounts).where(eq(accounts.handle, 'house'));
    expect(houseBefore.balanceMicro - houseAfter.balanceMicro).toBe(BigInt(res.body.subsidyMicro));
    const [row] = await db.select().from(markets).where(eq(markets.slug, 'new-market'));
    expect(row.createdBy).toBe(admin.id);
  });

  it('refuses a duplicate slug, a past close, a uuid-shaped slug and a one-outcome market', async () => {
    const admin = await trader('creator', ['admin']);
    const base = {
      question: 'q',
      outcomes: ['A', 'B'],
      closesAt: new Date(Date.now() + 86_400_000).toISOString(),
      expectedTraders: 10,
    };
    const dup = await api('POST', '/markets', { token: admin.token, body: { ...base, slug: 'concurrency' } });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('slug_taken');

    for (const body of [
      { ...base, slug: 'past', closesAt: new Date(Date.now() - 1000).toISOString() },
      { ...base, slug: '00000000-0000-4000-8000-000000000000' },
      { ...base, slug: 'one', outcomes: ['A'] },
      { ...base, slug: 'dupe-labels', outcomes: ['A', 'A'] },
      { ...base, slug: 'Upper' },
    ]) {
      const res = await api('POST', '/markets', { token: admin.token, body });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('validation_error');
    }
  });

  it('settles idempotently, and refuses a different winner afterwards', async () => {
    const admin = await trader('settler', ['admin']);
    const t = await trader('bettor');
    await buy(t.token, fx.outcomeIds[0], 10_000_000n);

    const body = { winningOutcomeId: fx.outcomeIds[0], evidenceUrl: 'https://example.org/a' };
    const first = await api('POST', `/markets/${fx.marketId}/settle`, { token: admin.token, body });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ status: 'settled', resolvedOutcomeId: fx.outcomeIds[0] });
    const ledgerAfterFirst = (await db.select().from(ledgerEntries)).length;

    const again = await api('POST', `/markets/${fx.marketId}/settle`, { token: admin.token, body });
    expect(again.status).toBe(200);
    expect((await db.select().from(ledgerEntries)).length).toBe(ledgerAfterFirst);

    const other = await api('POST', `/markets/${fx.marketId}/settle`, {
      token: admin.token,
      body: { ...body, winningOutcomeId: fx.outcomeIds[1] },
    });
    expect(other.status).toBe(409);
    expect(other.body.error.code).toBe('market_already_settled');

    const bad = await api('POST', `/markets/${fx.marketId}/settle`, {
      token: admin.token,
      body: { winningOutcomeId: fx.outcomeIds[0], evidenceUrl: 'javascript:alert(1)' },
    });
    expect(bad.status).toBe(400);
    expect(await reconcileBalances(db)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// the event log (§1.4)
// ---------------------------------------------------------------------------

describe('the event log', () => {
  it('records reads with kind and ids only', async () => {
    const t = await trader('watcher');
    await api('GET', `/markets/${fx.marketId}`, { token: t.token });
    await api('GET', `/markets/${fx.marketId}/orders`);
    await api('GET', '/me/portfolio', { token: t.token });
    await api('GET', '/leaderboard');
    await settleEvents();

    const rows = await db.select().from(events);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'market.read', accountId: t.id, marketId: fx.marketId }),
        expect.objectContaining({ kind: 'market.tape.read', accountId: null, marketId: fx.marketId }),
        expect.objectContaining({ kind: 'portfolio.read', accountId: t.id }),
        expect.objectContaining({ kind: 'leaderboard.read' }),
      ]),
    );
    const columns = await db.execute(
      sql`select column_name from information_schema.columns where table_name = 'events' order by column_name`,
    );
    expect(columns.rows.map((r) => r.column_name)).toEqual(['account_id', 'created_at', 'id', 'kind', 'market_id']);
  });
});
