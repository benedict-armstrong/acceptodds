import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { account as authAccount, user } from '@/db/auth-schema';
import { accounts, pendingBets } from '@/db/schema';
import { WELCOME_FINISH } from '@/lib/onboarding';
import { clearDevOutbox, devOutbox } from '@/server/mail';
import { api, authCall, cookieFrom, signUp } from './api-client';
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

const STAKE = 100_000_000n;

function start(email: string, extra: Record<string, unknown> = {}) {
  return api('POST', '/onboarding', {
    body: {
      email,
      name: 'Ada Lovelace',
      marketId: fx.marketId,
      outcomeId: fx.outcomeIds[0],
      stakeMicro: STAKE.toString(),
      seenOrderCount: 0,
      comment: 'Strong ablations.',
      ...extra,
    },
  });
}

/** Open the link in the newest mail to `email`; the session cookie and where it redirected. */
async function clickLink(email: string) {
  const mail = devOutbox().findLast((m) => m.to === email);
  if (!mail) throw new Error('no mail');
  const link = new URL(/https?:\/\/\S+/.exec(mail.text)![0]);
  const res = await authCall('GET', `${link.pathname.replace(/^\/api\/auth/, '')}${link.search}`);
  return { cookie: cookieFrom(res), location: res.headers.get('location') };
}

async function userRow(email: string) {
  const [row] = await db.select().from(user).where(eq(user.email, email));
  return row;
}

describe('onboarding', () => {
  it('stores the bet, creates no account, and mails a link back to /welcome', async () => {
    const res = await start('ada@example.org');
    expect(res.status).toBe(200);

    const u = await userRow('ada@example.org');
    expect(u.emailVerified).toBe(false);
    expect(await db.select().from(accounts).where(eq(accounts.userId, u.id))).toEqual([]);
    expect(await db.select().from(authAccount).where(eq(authAccount.userId, u.id))).toEqual([]);
    const [bet] = await db.select().from(pendingBets).where(eq(pendingBets.userId, u.id));
    expect(bet).toMatchObject({
      marketId: fx.marketId,
      outcomeId: fx.outcomeIds[0],
      stakeMicro: STAKE,
      seenOrderCount: 0,
      comment: 'Strong ablations.',
    });

    const mail = devOutbox().find((m) => m.to === 'ada@example.org')!;
    expect(mail.text).toContain(encodeURIComponent(WELCOME_FINISH));
  });

  it('refuses an address outside the allowlist before creating anything', async () => {
    const res = await start('someone@gmail.com');
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('email_domain_not_allowed');
    expect(await userRow('someone@gmail.com')).toBeUndefined();
    expect(devOutbox()).toEqual([]);
  });

  it('refuses a stake above the starting balance', async () => {
    const res = await start('ada@example.org', { stakeMicro: (STARTING_MICRO + 1n).toString() });
    expect(res.status).toBe(400);
  });

  it('confirming signs in with the starting balance; then a first password, the bet as an order, and the row dropped', async () => {
    await start('ada@example.org');
    const { cookie, location } = await clickLink('ada@example.org');
    expect(cookie).toContain('session_token');
    expect(location).toBe(WELCOME_FINISH);

    const me = await api('GET', '/me', { cookie });
    expect(me.body).toMatchObject({ canTrade: true, balanceMicro: STARTING_MICRO.toString() });

    expect((await api('POST', '/me/password', { cookie, body: { password: 'short' } })).status).toBe(400);
    expect((await api('POST', '/me/password', { cookie, body: { password: 'correct horse battery' } })).status).toBe(200);
    const again = await api('POST', '/me/password', { cookie, body: { password: 'another horse battery' } });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('password_already_set');

    // The new password signs in.
    const signIn = await authCall('POST', '/sign-in/email', { body: { email: 'ada@example.org', password: 'correct horse battery' } });
    expect(signIn.status).toBe(200);

    expect((await api('DELETE', '/me/pending-bet', { cookie })).status).toBe(204);
    const u = await userRow('ada@example.org');
    expect(await db.select().from(pendingBets).where(eq(pendingBets.userId, u.id))).toEqual([]);
  });

  it('answers the same for a confirmed address, mails "sign in", and stores no bet', async () => {
    await signUp('ada@example.org', 'Ada');
    clearDevOutbox();

    const res = await start('ada@example.org');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ email: 'ada@example.org' });
    expect(await db.select().from(pendingBets)).toEqual([]);
    expect(devOutbox()).toEqual([expect.objectContaining({ to: 'ada@example.org', subject: expect.stringContaining('already have') })]);
  });

  it('replaces the bet of an address not yet confirmed, and resends', async () => {
    await start('ada@example.org');
    await start('ada@example.org', { outcomeId: fx.outcomeIds[1], comment: null });
    const rows = await db.select().from(pendingBets);
    expect(rows).toEqual([expect.objectContaining({ outcomeId: fx.outcomeIds[1], comment: null })]);
    expect(devOutbox().filter((m) => m.to === 'ada@example.org')).toHaveLength(2);
  });

  it('mails one address at most five times a day', async () => {
    for (let i = 0; i < 5; i += 1) expect((await start('ada@example.org')).status).toBe(200);
    const res = await start('ada@example.org');
    expect(res.status).toBe(429);
  });

  it('password and pending-bet endpoints are session only', async () => {
    expect((await api('POST', '/me/password', { body: { password: 'correct horse battery' } })).status).toBe(401);
    expect((await api('DELETE', '/me/pending-bet')).status).toBe(401);
  });
});
