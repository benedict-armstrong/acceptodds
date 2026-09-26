import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { getDb } from '@/db';
import { account as authAccount, user } from '@/db/auth-schema';
import { accounts, institutionVerifications, ledgerEntries } from '@/db/schema';
import { ensureAccountForUser } from '@/server/accounts';
import { clearDevOutbox, devOutbox } from '@/server/mail';
import { buildRorIndex } from '@/server/ror';
import { api, authCall, cookieFrom, ORIGIN, signUp, trader } from './api-client';
import { closePool, resetDatabase, seedMarket, STARTING_MICRO, type Fixture } from './helpers';

const db = getDb();
let fx: Fixture;
let rorIndexPath: string;

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'pm-ror-'));
  rorIndexPath = join(dir, 'ror-index.json');
  const dump = JSON.parse(readFileSync('tests/fixtures/ror-dump.json', 'utf8'));
  writeFileSync(rorIndexPath, JSON.stringify(buildRorIndex(dump, 'fixture')));
});

beforeEach(async () => {
  await resetDatabase();
  process.env.API_RATE_LIMIT_BURST = '1000';
  process.env.API_RATE_LIMIT_PER_SECOND = '1000';
  process.env.STARTING_BALANCE_MICRO = STARTING_MICRO.toString();
  process.env.ROR_INDEX_PATH = rorIndexPath;
  clearDevOutbox();
  fx = await seedMarket(0, 10);
}, 60_000);

afterAll(async () => {
  await closePool();
});

function lastCode(to: string): string {
  const mail = [...devOutbox()].reverse().find((m) => m.to === to);
  if (!mail) throw new Error(`no mail to ${to}`);
  return /\b(\d{6})\b/.exec(mail.text)![1];
}

const order = (outcomeId: string) => ({ outcomeId, sharesMicro: '1000000', maxCostMicro: '10000000' });

// ---------------------------------------------------------------------------
// sign-up
// ---------------------------------------------------------------------------

describe('sign-up with email and password', () => {
  it('creates a trader with the starting balance as a signup ledger entry, and a session', async () => {
    const cookie = await signUp('ada@example.org', 'Ada Lovelace');

    const me = await api('GET', '/me', { cookie });
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({
      handle: 'ada-lovelace',
      displayName: 'Ada Lovelace',
      isBot: false,
      verifiedAt: null,
      canTrade: false,
      balanceMicro: STARTING_MICRO.toString(),
      auth: { method: 'session', scopes: ['read', 'trade'] },
    });

    const entries = await db.select().from(ledgerEntries).where(eq(ledgerEntries.accountId, me.body.id));
    expect(entries).toEqual([expect.objectContaining({ reason: 'signup', deltaMicro: STARTING_MICRO })]);
  });

  it('refuses to sign in before the email is confirmed', async () => {
    const up = await authCall('POST', '/sign-up/email', {
      body: { email: 'slow@example.org', password: 'correct horse battery', name: 'Slow' },
    });
    expect(up.status).toBe(200);
    expect(cookieFrom(up)).not.toContain('session_token=');

    const inRes = await authCall('POST', '/sign-in/email', {
      body: { email: 'slow@example.org', password: 'correct horse battery' },
    });
    expect(inRes.status).toBe(403);
    expect(cookieFrom(inRes)).not.toContain('session_token=');
  });

  it('gives two users with the same name different handles', async () => {
    const a = await api('GET', '/me', { cookie: await signUp('one@example.org', 'Sam Smith') });
    const b = await api('GET', '/me', { cookie: await signUp('two@example.org', 'Sam Smith') });
    expect(a.body.handle).toBe('sam-smith');
    expect(b.body.handle).toMatch(/^sam-smith-[a-z0-9]{4}$/);
  });

  it('provisions exactly one account per user, however many callers race', async () => {
    const id = 'race-user';
    await db.insert(user).values({ id, name: 'Racer', email: 'racer@example.org', emailVerified: true });
    const results = await Promise.all(
      Array.from({ length: 6 }, () => ensureAccountForUser({ id, name: 'Racer', email: 'racer@example.org' })),
    );
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    const rows = await db.select().from(accounts).where(eq(accounts.userId, id));
    expect(rows).toHaveLength(1);
    const grants = await db.select().from(ledgerEntries).where(eq(ledgerEntries.accountId, rows[0].id));
    expect(grants).toHaveLength(1);
  });

  it('ends the session on sign-out', async () => {
    const cookie = await signUp('bye@example.org');
    const out = await authCall('POST', '/sign-out', { cookie, body: {} });
    expect(out.status).toBe(200);
    expect((await api('GET', '/me', { cookie })).status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// sessions on the API
// ---------------------------------------------------------------------------

describe('a session on /api/v1', () => {
  it('may browse and quote but never administer', async () => {
    const cookie = await signUp('browser@example.org');
    expect((await api('GET', '/markets', { cookie })).status).toBe(200);
    const q = await api('POST', `/markets/${fx.marketId}/quote`, {
      cookie,
      body: { outcomeId: fx.outcomeIds[0], sharesMicro: '1000000' },
    });
    expect(q.status).toBe(200);

    const close = await api('POST', `/markets/${fx.marketId}/close`, { cookie });
    expect(close.status).toBe(403);
    expect(close.body.error).toMatchObject({ code: 'forbidden', details: { requiredScope: 'admin' } });
  });

  it('refuses a cookie-authenticated write from another origin, or with no Origin', async () => {
    const cookie = await signUp('csrf@example.org');
    for (const origin of ['https://evil.example', null]) {
      const res = await api('POST', `/markets/${fx.marketId}/orders`, { cookie, origin, body: order(fx.outcomeIds[0]) });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('forbidden');
    }
    // Reads don't need it.
    expect((await api('GET', '/me', { cookie, origin: null })).status).toBe(200);
  });

  it('is rate limited per user', async () => {
    process.env.API_RATE_LIMIT_BURST = '2';
    process.env.API_RATE_LIMIT_PER_SECOND = '0.001';
    const cookie = await signUp('busy@example.org');
    expect((await api('GET', '/me', { cookie })).status).toBe(200);
    expect((await api('GET', '/me', { cookie })).status).toBe(200);
    const limited = await api('GET', '/me', { cookie });
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('rate_limited');
  });

  it('treats a garbage cookie as anonymous on public routes and 401 on protected ones', async () => {
    const cookie = 'better-auth.session_token=nope';
    expect((await api('GET', '/markets', { cookie })).status).toBe(200);
    expect((await api('GET', '/me', { cookie })).status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// trading is gated on institutional verification (§8)
// ---------------------------------------------------------------------------

describe('trading eligibility', () => {
  it('refuses an unverified human with not_verified, by session or by token', async () => {
    const cookie = await signUp('unverified@example.org');
    const bySession = await api('POST', `/markets/${fx.marketId}/orders`, { cookie, body: order(fx.outcomeIds[0]) });
    expect(bySession.status).toBe(403);
    expect(bySession.body.error.code).toBe('not_verified');

    const t = await trader('unverified-token', ['read', 'trade'], { verified: false });
    const byToken = await api('POST', `/markets/${fx.marketId}/orders`, { token: t.token, body: order(fx.outcomeIds[0]) });
    expect(byToken.status).toBe(403);
    expect(byToken.body.error.code).toBe('not_verified');
  });

  it('exempts bots', async () => {
    const bot = await trader('robo', ['read', 'trade'], { isBot: true });
    const res = await api('POST', `/markets/${fx.marketId}/orders`, { token: bot.token, body: order(fx.outcomeIds[0]) });
    expect(res.status).toBe(201);
  });
});

describe('institutional verification', () => {
  it('sends a code to an address at a ROR institution; confirming it unlocks trading', async () => {
    const cookie = await signUp('grace@example.org', 'Grace');

    const start = await api('POST', '/me/institution', { cookie, body: { email: 'Grace@Inf.ETHZ.ch' } });
    expect(start.status).toBe(202);
    expect(start.body).toMatchObject({
      email: 'grace@inf.ethz.ch',
      institution: { rorId: 'https://ror.org/05a28rw58', name: 'ETH Zurich' },
    });
    const code = lastCode('grace@inf.ethz.ch');

    // The code is not stored anywhere readable.
    const rows = await db.execute(sql`select * from institution_verifications`);
    expect(JSON.stringify(rows.rows)).not.toContain(code);

    const wrong = await api('POST', '/me/institution/verify', {
      cookie,
      body: { code: code === '000000' ? '000001' : '000000' },
    });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error).toMatchObject({ code: 'invalid_code', details: { attemptsRemaining: 4 } });

    const ok = await api('POST', '/me/institution/verify', { cookie, body: { code } });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({
      canTrade: true,
      institutionName: 'ETH Zurich',
      rorId: 'https://ror.org/05a28rw58',
      verifiedAt: expect.any(String),
    });

    // Used once.
    const again = await api('POST', '/me/institution/verify', { cookie, body: { code } });
    expect(again.status).toBe(404);

    const trade = await api('POST', `/markets/${fx.marketId}/orders`, { cookie, body: order(fx.outcomeIds[0]) });
    expect(trade.status).toBe(201);

    // And the public profile shows the institution.
    const profile = await api('GET', `/accounts/${ok.body.handle}`);
    expect(profile.body).toMatchObject({ institutionName: 'ETH Zurich', verifiedAt: expect.any(String) });
  });

  it('refuses a domain that is not a registered institution, and sends nothing', async () => {
    const cookie = await signUp('free@example.org');
    for (const email of ['me@gmail.com', 'me@shared.org', 'me@defunct.edu']) {
      const res = await api('POST', '/me/institution', { cookie, body: { email } });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('unknown_institution');
    }
    expect(devOutbox().filter((m) => m.to.startsWith('me@'))).toEqual([]);
  });

  it('expires a code after 15 minutes or 5 wrong guesses', async () => {
    const cookie = await signUp('tries@example.org');
    await api('POST', '/me/institution', { cookie, body: { email: 'tries@ethz.ch' } });
    const code = lastCode('tries@ethz.ch');
    const wrong = code === '999999' ? '999998' : '999999';
    const guesses = [];
    for (let i = 0; i < 5; i += 1) {
      guesses.push((await api('POST', '/me/institution/verify', { cookie, body: { code: wrong } })).body.error);
    }
    expect(guesses.map((g) => g.details?.attemptsRemaining)).toEqual([4, 3, 2, 1, 0]);
    const locked = await api('POST', '/me/institution/verify', { cookie, body: { code } });
    expect(locked.status).toBe(410);
    expect(locked.body.error.code).toBe('code_expired');

    await api('POST', '/me/institution', { cookie, body: { email: 'tries@ethz.ch' } });
    await db.update(institutionVerifications).set({ expiresAt: new Date(Date.now() - 1000) });
    const stale = await api('POST', '/me/institution/verify', { cookie, body: { code: lastCode('tries@ethz.ch') } });
    expect(stale.status).toBe(410);
  });

  it('a new code supersedes the old one', async () => {
    const cookie = await signUp('twice@example.org');
    await api('POST', '/me/institution', { cookie, body: { email: 'twice@ethz.ch' } });
    const first = lastCode('twice@ethz.ch');
    clearDevOutbox();
    await api('POST', '/me/institution', { cookie, body: { email: 'twice@ethz.ch' } });
    const second = lastCode('twice@ethz.ch');
    if (first !== second) {
      const old = await api('POST', '/me/institution/verify', { cookie, body: { code: first } });
      expect(old.body.error.code).toBe('invalid_code');
    }
    expect((await api('POST', '/me/institution/verify', { cookie, body: { code: second } })).status).toBe(200);
  });

  it('limits how many codes an account may request per hour', async () => {
    const cookie = await signUp('spam@example.org');
    const statuses = [];
    for (let i = 0; i < 6; i += 1) {
      statuses.push((await api('POST', '/me/institution', { cookie, body: { email: 'spam@ethz.ch' } })).status);
    }
    expect(statuses).toEqual([202, 202, 202, 202, 202, 429]);
  });

  it('is unavailable, not broken, without a ROR index', async () => {
    delete process.env.ROR_INDEX_PATH;
    const cookie = await signUp('noindex@example.org');
    const res = await api('POST', '/me/institution', { cookie, body: { email: 'x@ethz.ch' } });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('institution_directory_unavailable');
  });

  it('is session-only', async () => {
    const t = await trader('tokened', ['read', 'trade'], { verified: false });
    const res = await api('POST', '/me/institution', { token: t.token, body: { email: 'x@ethz.ch' } });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('session_required');
  });
});

// ---------------------------------------------------------------------------
// API tokens via the apiKey plugin
// ---------------------------------------------------------------------------

describe('token management', () => {
  it('a signed-in user mints, lists and revokes their own tokens', async () => {
    const cookie = await signUp('keys@example.org', 'Key Holder');

    const minted = await api('POST', '/me/tokens', { cookie, body: { name: 'laptop', scopes: ['read'] } });
    expect(minted.status).toBe(201);
    expect(minted.body.token).toMatch(/^pm_live_[A-Za-z0-9_-]{43}$/);
    expect(minted.body.start).toBe(minted.body.token.slice(0, 16));
    expect(minted.body.scopes).toEqual(['read']);

    // The token works, as the same account, with only its scopes.
    const me = await api('GET', '/me', { token: minted.body.token });
    expect(me.body).toMatchObject({ handle: 'key-holder', auth: { method: 'token', scopes: ['read'] } });

    const list = await api('GET', '/me/tokens', { cookie });
    expect(list.body.tokens).toHaveLength(1);
    expect(list.body.tokens[0]).toMatchObject({ id: minted.body.id, name: 'laptop', enabled: true });
    expect(JSON.stringify(list.body)).not.toContain(minted.body.token);

    const revoked = await api('DELETE', `/me/tokens/${minted.body.id}`, { cookie });
    expect(revoked.status).toBe(204);
    expect((await api('GET', '/me', { token: minted.body.token })).status).toBe(401);
    expect((await api('GET', '/me/tokens', { cookie })).body.tokens[0].enabled).toBe(false);
  });

  it('never mints admin tokens from a session', async () => {
    const cookie = await signUp('greedy@example.org');
    const res = await api('POST', '/me/tokens', { cookie, body: { name: 'x', scopes: ['admin'] } });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_error');
  });

  it("cannot revoke someone else's token", async () => {
    const other = await trader('victim');
    const cookie = await signUp('attacker@example.org');
    const res = await api('DELETE', `/me/tokens/${other.tokenId}`, { cookie });
    expect(res.status).toBe(404);
    expect((await api('GET', '/me', { token: other.token })).status).toBe(200);
  });

  it('refuses every token-management call made with a token', async () => {
    const t = await trader('tok');
    for (const [method, path] of [
      ['GET', '/me/tokens'],
      ['POST', '/me/tokens'],
      ['DELETE', `/me/tokens/${t.tokenId}`],
    ] as const) {
      const res = await api(method, path, { token: t.token, body: method === 'POST' ? { name: 'x', scopes: ['read'] } : undefined });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('session_required');
    }
  });

  it('issues a bot a login-less user the first time it gets a token', async () => {
    const bot = await trader('login-less', ['read'], { isBot: true });
    const [u] = await db.select().from(user).where(eq(user.id, bot.userId));
    expect(u.email).toBe('login-less@bots.papermarket.invalid');
    // No credential or linked provider: nothing can sign in as it.
    expect(await db.select().from(authAccount).where(eq(authAccount.userId, bot.userId))).toEqual([]);
  });

  it('stores only a hash of each token', async () => {
    const cookie = await signUp('hash@example.org');
    const minted = await api('POST', '/me/tokens', { cookie, body: { name: 'x', scopes: ['read', 'trade'] } });
    const rows = await db.execute(sql`select * from apikey`);
    expect(JSON.stringify(rows.rows)).not.toContain(minted.body.token);
  });
});

describe('Better Auth configuration', () => {
  it('trusts only our own origin for its own endpoints', async () => {
    const req = new Request(new URL('/api/auth/sign-up/email', ORIGIN), {
      method: 'POST',
      headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'x@example.org', password: 'correct horse battery', name: 'X' }),
    });
    const { POST } = await import('@/app/api/auth/[...all]/route');
    const res = await POST(req);
    expect(res.status).toBe(403);
  });
});
