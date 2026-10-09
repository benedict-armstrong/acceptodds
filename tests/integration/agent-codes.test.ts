import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { account as authAccount, user } from '@/db/auth-schema';
import { accounts, orders } from '@/db/schema';
import { MAX_ATTEMPTS } from '@/server/agent-codes';
import { clearDevOutbox, devOutbox } from '@/server/mail';
import { api, signUp, trader } from './api-client';
import { closePool, resetDatabase, seedMarket, STARTING_MICRO, type Fixture } from './helpers';

const db = getDb();
let fx: Fixture;

beforeEach(async () => {
  await resetDatabase();
  process.env.API_RATE_LIMIT_BURST = '1000';
  process.env.API_RATE_LIMIT_PER_SECOND = '1000';
  process.env.STARTING_BALANCE_MICRO = STARTING_MICRO.toString();
  process.env.INSTITUTION_DOMAINS_PATH = 'tests/fixtures/institution-domains.json';
  clearDevOutbox();
  fx = await seedMarket(0, 10);
}, 60_000);

afterAll(async () => {
  await closePool();
});

/** Asks for a code for `email`, as an agent does, and reads it from the mail the person gets. */
async function mailedCode(email: string): Promise<string | null> {
  clearDevOutbox();
  const res = await api('POST', '/agent/code', { body: { email } });
  expect(res.status).toBe(200);
  const mail = devOutbox().find((m) => m.to === email.toLowerCase());
  expect(mail).toBeDefined();
  return /code: (\d{6})/.exec(mail!.text)?.[1] ?? null;
}

const redeem = (email: string, code: string) => api('POST', '/agent/token', { body: { email, code } });

/** Any 6-digit code but this one. */
const wrong = (code: string) => String((Number(code) + 1) % 1_000_000).padStart(6, '0');

describe('agent sign-in by mailed code', () => {
  it('mails a code that trades for a working read + trade key, once', async () => {
    await signUp('ada@example.org', 'Ada Lovelace');
    const code = await mailedCode('Ada@Example.org');
    expect(code).toMatch(/^\d{6}$/);

    const minted = await redeem('ada@example.org', code!);
    expect(minted.status).toBe(201);
    expect(minted.body).toMatchObject({ name: 'ai-agent', scopes: ['read', 'trade'] });
    const me = await api('GET', '/me', { token: minted.body.token });
    expect(me.body.handle).toBe('ada-lovelace');

    // The key trades as the person, recorded as an API order a model placed.
    const q = await api('POST', `/markets/${fx.marketId}/quote`, {
      body: { outcomeId: fx.outcomeIds[0], sharesMicro: '1000000' },
    });
    const fill = await api('POST', `/markets/${fx.marketId}/orders`, {
      token: minted.body.token,
      body: { outcomeId: fx.outcomeIds[0], sharesMicro: '1000000', maxCostMicro: q.body.costMicro, isLlm: true },
    });
    expect(fill.status).toBe(201);
    const [placed] = await db.select().from(orders).where(eq(orders.id, fill.body.orderId));
    expect(placed).toMatchObject({ via: 'api', isLlm: true });

    // Used up.
    const again = await redeem('ada@example.org', code!);
    expect(again.status).toBe(422);
    expect(again.body.error.code).toBe('invalid_code');
  });

  it('makes an account for a new address, confirmed by the code, and none before', async () => {
    const code = await mailedCode('newcomer@example.org');
    expect(code).toMatch(/^\d{6}$/);
    const [pending] = await db.select().from(user).where(eq(user.email, 'newcomer@example.org'));
    expect(pending).toMatchObject({ emailVerified: false, name: '' });
    expect(await db.select().from(accounts).where(eq(accounts.userId, pending.id))).toEqual([]);

    expect((await redeem('newcomer@example.org', wrong(code!))).status).toBe(422);
    const minted = await redeem('newcomer@example.org', code!);
    expect(minted.status).toBe(201);
    const [confirmed] = await db.select().from(user).where(eq(user.id, pending.id));
    expect(confirmed.emailVerified).toBe(true);

    const me = await api('GET', '/me', { token: minted.body.token });
    expect(me.status).toBe(200);
    expect(me.body.handle).toMatch(/^trader-/);
    expect(me.body).toMatchObject({ wallets: [], canTrade: true });

    // Confirmed now, so the next code is an ordinary sign-in for the same account.
    const next = (await mailedCode('newcomer@example.org'))!;
    const again = await redeem('newcomer@example.org', next);
    expect((await api('GET', '/me', { token: again.body.token })).body.handle).toBe(me.body.handle);
  });

  it('drops a password set on an unconfirmed address when the code confirms it', async () => {
    await mailedCode('newcomer@example.org');
    const [pending] = await db.select().from(user).where(eq(user.email, 'newcomer@example.org'));
    await db.insert(authAccount).values({
      id: 'planted',
      accountId: pending.id,
      providerId: 'credential',
      userId: pending.id,
      password: 'not-theirs',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const code = (await mailedCode('newcomer@example.org'))!;
    expect((await redeem('newcomer@example.org', code)).status).toBe(201);
    expect(await db.select().from(authAccount).where(eq(authAccount.userId, pending.id))).toEqual([]);
  });

  it('refuses an address outside the allowlist before mailing anything', async () => {
    const res = await api('POST', '/agent/code', { body: { email: 'someone@gmail.com' } });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('email_domain_not_allowed');
    expect(devOutbox()).toEqual([]);
  });

  it('replaces the code on a second request', async () => {
    await signUp('ada@example.org', 'Ada Lovelace');
    const first = (await mailedCode('ada@example.org'))!;
    const second = (await mailedCode('ada@example.org'))!;
    if (first !== second) expect((await redeem('ada@example.org', first)).status).toBe(422);
    expect((await redeem('ada@example.org', second)).status).toBe(201);
  });

  it(`kills a code after ${MAX_ATTEMPTS} wrong guesses, even the right one after`, async () => {
    await signUp('ada@example.org', 'Ada Lovelace');
    const code = (await mailedCode('ada@example.org'))!;
    for (let i = 0; i < MAX_ATTEMPTS; i++) expect((await redeem('ada@example.org', wrong(code))).status).toBe(422);
    expect((await redeem('ada@example.org', code)).status).toBe(422);
  });

  it('gives a signed-in person a code for their prompt, with no mail, that redeems the same way', async () => {
    const cookie = await signUp('ada@example.org', 'Ada Lovelace');
    clearDevOutbox();
    const issued = await api('POST', '/me/agent-code', { cookie });
    expect(issued.status).toBe(201);
    expect(issued.body).toMatchObject({ email: 'ada@example.org', code: expect.stringMatching(/^\d{6}$/) });
    const minutes = (Date.parse(issued.body.expiresAt) - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(59);
    expect(minutes).toBeLessThanOrEqual(60);
    expect(devOutbox()).toEqual([]);

    const minted = await redeem(issued.body.email, issued.body.code);
    expect(minted.status).toBe(201);
    expect((await api('GET', '/me', { token: minted.body.token })).body.handle).toBe('ada-lovelace');
  });

  it('asks for a session to put a code in a prompt, never a key', async () => {
    const t = await trader('keyholder');
    const res = await api('POST', '/me/agent-code', { token: t.token });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('session_required');
  });
});
