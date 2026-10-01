import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { account as authAccount, user } from '@/db/auth-schema';
import { accounts, pendingBets } from '@/db/schema';
import { VERIFY_EMAIL } from '@/lib/return-to';
import { getAuth } from '@/server/better-auth';
import { clearDevOutbox, devOutbox } from '@/server/mail';
import { choseHere, ONBOARDING_BROWSER_COOKIE, pendingBetFor } from '@/server/onboarding';
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
      marketId: fx.marketId,
      outcomeId: fx.outcomeIds[0],
      stakeMicro: STAKE.toString(),
      seenOrderCount: 0,
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
  it('stores the bet, creates no account, and mails a link to /verify-email', async () => {
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
    });

    const mail = devOutbox().find((m) => m.to === 'ada@example.org')!;
    expect(mail.text).toContain(encodeURIComponent(VERIFY_EMAIL));
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
    expect(location).toBe(VERIFY_EMAIL);

    const me = await api('GET', '/me', { cookie });
    expect(me.body).toMatchObject({ canTrade: true, balanceMicro: STARTING_MICRO.toString() });

    expect((await api('POST', '/me/password', { cookie, body: { password: 'short' } })).status).toBe(400);
    expect((await api('POST', '/me/password', { cookie, body: { password: 'correct horse battery' } })).status).toBe(
      200,
    );
    const again = await api('POST', '/me/password', { cookie, body: { password: 'another horse battery' } });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('password_already_set');

    // The new password signs in.
    const signIn = await authCall('POST', '/sign-in/email', {
      body: { email: 'ada@example.org', password: 'correct horse battery' },
    });
    expect(signIn.status).toBe(200);

    expect((await api('DELETE', '/me/pending-bet', { cookie })).status).toBe(204);
    const u = await userRow('ada@example.org');
    expect(await db.select().from(pendingBets).where(eq(pendingBets.userId, u.id))).toEqual([]);
  });

  it('answers the same for a confirmed address, mails a sign-in link, and stores the bet for it', async () => {
    await signUp('ada@example.org', 'Ada');
    clearDevOutbox();

    const res = await start('ada@example.org');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ email: 'ada@example.org' });
    const u = await userRow('ada@example.org');
    expect((await pendingBetFor(u.id))?.stakeMicro).toBe(STAKE);
    const [mail] = devOutbox();
    expect(mail).toMatchObject({ to: 'ada@example.org', subject: expect.stringContaining('sign-in link') });

    // Opening it signs in, and lands where the bet is placed.
    const { location, cookie } = await clickLink('ada@example.org');
    expect(cookie).toContain('session');
    expect(location).toContain(VERIFY_EMAIL);
  });

  it('a password-reset mail to an account with no password yet sets its first one, then signs in', async () => {
    await start('ada@example.org');
    await clickLink('ada@example.org'); // confirmed, but never chose a password
    clearDevOutbox();

    await getAuth().api.requestPasswordReset({
      body: { email: 'ada@example.org', redirectTo: '/set-password?email=ada%40example.org' },
    });
    const [mail] = devOutbox();
    expect(mail).toMatchObject({ to: 'ada@example.org', subject: expect.stringContaining('Choose your') });
    expect(mail.text).toContain('no password yet');

    // The link redirects to /set-password with the address and a token.
    const link = new URL(/https?:\/\/\S+/.exec(mail.text)![0]);
    const res = await authCall('GET', `${link.pathname.replace(/^\/api\/auth/, '')}${link.search}`);
    const landing = new URL(res.headers.get('location')!, 'http://test.local');
    expect(landing.pathname).toBe('/set-password');
    expect(landing.searchParams.get('email')).toBe('ada@example.org');
    const token = landing.searchParams.get('token')!;

    const set = await authCall('POST', '/reset-password', { body: { newPassword: 'correct horse battery', token } });
    expect(set.status).toBe(200);
    const signIn = await authCall('POST', '/sign-in/email', {
      body: { email: 'ada@example.org', password: 'correct horse battery' },
    });
    expect(signIn.status).toBe(200);
    // Once only.
    expect(
      (await authCall('POST', '/reset-password', { body: { newPassword: 'another horse battery', token } })).status,
    ).toBe(400);
  });

  it("names the browser the bet was chosen in, and a replaced bet is no longer that browser's", async () => {
    const mine = await start('ada@example.org');
    const cookie = mine.headers.get('set-cookie')!;
    expect(cookie).toContain(`${ONBOARDING_BROWSER_COOKIE}=`);
    expect(cookie).toContain('HttpOnly');
    const nonce = new RegExp(`${ONBOARDING_BROWSER_COOKIE}=([^;]+)`).exec(cookie)![1];
    const u = await userRow('ada@example.org');
    expect(choseHere((await pendingBetFor(u.id))!, nonce)).toBe(true);
    expect(choseHere((await pendingBetFor(u.id))!, undefined)).toBe(false);

    // Someone else onboards with the same unconfirmed address: their bet is
    // never placed unasked, in their browser or in the owner's.
    const theirs = await start('ada@example.org', { outcomeId: fx.outcomeIds[1] });
    const theirNonce = new RegExp(`${ONBOARDING_BROWSER_COOKIE}=([^;]+)`).exec(theirs.headers.get('set-cookie')!)![1];
    const bet = (await pendingBetFor(u.id))!;
    expect(bet.outcomeId).toBe(fx.outcomeIds[1]);
    expect(choseHere(bet, nonce)).toBe(false);
    expect(choseHere(bet, theirNonce)).toBe(true); // theirs, but they never get the owner's session
  });

  it('sends a broken or reused link back to /verify-email, which sends it on to /signin with the reason', async () => {
    await start('ada@example.org');
    const mail = devOutbox().findLast((m) => m.to === 'ada@example.org')!;
    const link = new URL(/https?:\/\/\S+/.exec(mail.text)![0]);
    const path = link.pathname.replace(/^\/api\/auth/, '');

    // Tampered: back to the callback with ?error=, and no session.
    const bad = new URLSearchParams(link.search);
    bad.set('token', `${bad.get('token')}x`);
    const broken = await authCall('GET', `${path}?${bad}`);
    const brokenAt = new URL(broken.headers.get('location')!, 'http://test.local');
    expect(brokenAt.pathname).toBe(VERIFY_EMAIL);
    expect(brokenAt.searchParams.get('error')).toBe('INVALID_TOKEN');
    expect(cookieFrom(broken)).not.toContain('session_token');

    // Opened twice: the second time is a bare redirect with no session (LINK_USED).
    expect(cookieFrom(await authCall('GET', `${path}${link.search}`))).toContain('session_token');
    const again = await authCall('GET', `${path}${link.search}`);
    expect(new URL(again.headers.get('location')!, 'http://test.local').searchParams.get('error')).toBeNull();
    expect(cookieFrom(again)).not.toContain('session_token');
  });

  it('replaces the bet of an address not yet confirmed, and resends', async () => {
    await start('ada@example.org');
    await start('ada@example.org', { outcomeId: fx.outcomeIds[1] });
    const rows = await db.select().from(pendingBets);
    expect(rows).toEqual([expect.objectContaining({ outcomeId: fx.outcomeIds[1] })]);
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
