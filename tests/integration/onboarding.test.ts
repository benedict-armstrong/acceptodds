import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { account as authAccount, user } from '@/db/auth-schema';
import { accounts, pendingBets } from '@/db/schema';
import { VERIFY_EMAIL } from '@/lib/return-to';
import { getAuth } from '@/server/better-auth';
import { clearDevOutbox, devOutbox } from '@/server/mail';
import {
  choseHere,
  ONBOARDING_BROWSER_COOKIE,
  pendingBetFor,
  pendingBetOrderKey,
  pruneUnconfirmedUsers,
} from '@/server/onboarding';
import { createAccount } from '@/server/accounts';
import { mintToken } from '@/server/tokens';
import { api, authCall, authPathOf, cookieFrom, signUp } from './api-client';
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
      bet: {
        marketId: fx.marketId,
        outcomeId: fx.outcomeIds[0],
        stakeMicro: STAKE.toString(),
        seenOrderCount: 0,
        ...extra,
      },
    },
  });
}

/** Open the link in the newest mail to `email`; the session cookie and where it redirected. */
async function clickLink(email: string) {
  const mail = devOutbox().findLast((m) => m.to === email);
  if (!mail) throw new Error('no mail');
  const link = new URL(/https?:\/\/\S+/.exec(mail.text)![0]);
  const res = await authCall('GET', `${authPathOf(link)}${link.search}`);
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

  it('refuses a +tag on a listed domain before creating anything', async () => {
    const res = await start('ada+again@example.org');
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('email_domain_not_allowed');
    expect(await userRow('ada+again@example.org')).toBeUndefined();
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

  it('without a bet: stores none, and the link and the code both sign in and return to `next`', async () => {
    const next = '/papers/some-paper?price=jev';
    const res = await api('POST', '/onboarding', { body: { email: 'ada@example.org', next } });
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie') ?? '').not.toContain(ONBOARDING_BROWSER_COOKIE);
    const u = await userRow('ada@example.org');
    expect(await pendingBetFor(u.id)).toBeNull();

    const mail = devOutbox().findLast((m) => m.to === 'ada@example.org')!;
    const code = /code is (\d{6})/.exec(mail.text)![1];
    const typed = await authCall('POST', '/email-otp/verify-email', { body: { email: 'ada@example.org', otp: code } });
    expect(typed.status).toBe(200);
    const cookie = cookieFrom(typed);
    expect((await api('GET', '/me', { cookie })).body).toMatchObject({ canTrade: true });

    // The same for a confirmed address, by its sign-in link.
    clearDevOutbox();
    await api('POST', '/onboarding', { body: { email: 'ada@example.org', next } });
    const { location } = await clickLink('ada@example.org');
    const landed = new URL(location!, 'http://test.local');
    expect(landed.pathname).toBe(VERIFY_EMAIL);
    expect(landed.searchParams.get('next')).toBe(next);
  });

  it('returns to `/` from a `next` off the site', async () => {
    await api('POST', '/onboarding', { body: { email: 'ada@example.org', next: '//evil.example/x' } });
    const { location } = await clickLink('ada@example.org');
    expect(new URL(location!, 'http://test.local').search).toBe('');
  });

  it('answers the same for a confirmed address, mails that it has an account with a link and a code, and stores the bet for it', async () => {
    await signUp('ada@example.org', 'Ada');
    clearDevOutbox();

    const res = await start('ada@example.org');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ email: 'ada@example.org' });
    const u = await userRow('ada@example.org');
    expect((await pendingBetFor(u.id))?.stakeMicro).toBe(STAKE);
    const [mail] = devOutbox();
    expect(mail).toMatchObject({ to: 'ada@example.org', subject: expect.stringContaining('sign-in code') });
    expect(mail.text).toContain('already has an acceptodds account');
    const code = /sign-in code is (\d{6})/.exec(mail.text)![1];

    // Opening it signs in, and lands where the bet is placed.
    const { location, cookie } = await clickLink('ada@example.org');
    expect(cookie).toContain('session');
    expect(location).toContain(VERIFY_EMAIL);

    // So does the code, typed on `/verify-email`; and it leaves the password be.
    const typed = await authCall('POST', '/email-otp/verify-email', { body: { email: 'ada@example.org', otp: code } });
    expect(typed.status).toBe(200);
    expect(cookieFrom(typed)).toContain('session_token');
    const signIn = await authCall('POST', '/sign-in/email', {
      body: { email: 'ada@example.org', password: 'correct horse battery' },
    });
    expect(signIn.status).toBe(200);
    expect(await db.select().from(accounts).where(eq(accounts.userId, u.id))).toHaveLength(1);
  });

  it('never mails a code for a sign-in link a client asked for, whatever metadata it sends', async () => {
    await signUp('ada@example.org', 'Ada');
    clearDevOutbox();
    const res = await authCall('POST', '/sign-in/magic-link', {
      body: { email: 'ada@example.org', callbackURL: VERIFY_EMAIL, metadata: { existingAccount: true } },
    });
    expect(res.status).toBe(200);
    const [mail] = devOutbox();
    expect(mail.subject).toContain('sign-in link');
    expect(mail.text).not.toMatch(/\b\d{6}\b/);
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
    const res = await authCall('GET', `${authPathOf(link)}${link.search}`);
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

  it('a pending bet has one order key, so two tabs placing it fill it once', async () => {
    await start('ada@example.org');
    const { cookie } = await clickLink('ada@example.org');
    const u = await userRow('ada@example.org');
    const key = pendingBetOrderKey((await pendingBetFor(u.id))!);
    expect(key).toBe(pendingBetOrderKey((await pendingBetFor(u.id))!));

    const order = (sharesMicro: string) =>
      api('POST', `/markets/${fx.marketId}/orders`, {
        cookie,
        headers: { 'Idempotency-Key': key },
        body: { outcomeId: fx.outcomeIds[0], sharesMicro, maxCostMicro: STAKE.toString() },
      });
    const first = await order('50000000');
    expect(first.status).toBe(201);
    // The other tab, sized on the same board: the original fill.
    const same = await order('50000000');
    expect(same.status).toBe(201);
    expect(same.body.orderId).toBe(first.body.orderId);
    // Sized on a board that has moved since: refused, never a second fill.
    const moved = await order('40000000');
    expect(moved.status).toBe(409);
    expect(moved.body.error.code).toBe('idempotency_key_reused');

    // A replaced bet is a new bet, with a new key.
    await start('ada@example.org', { outcomeId: fx.outcomeIds[1] });
    expect(pendingBetOrderKey((await pendingBetFor(u.id))!)).not.toBe(key);
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
    const path = authPathOf(link);

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

  it('prunes only unconfirmed sign-ups older than a week, keeping traders, bots and sign-ups in progress', async () => {
    const DAY = 86_400_000;
    const old = new Date(Date.now() - 8 * DAY);
    const userOf = async (email: string) => (await db.select().from(user).where(eq(user.email, email)))[0];

    // Unconfirmed, a week old, its bet as old: pruned, bet with it.
    await start('stale@example.org');
    await db.update(user).set({ createdAt: old }).where(eq(user.email, 'stale@example.org'));
    const stale = await userOf('stale@example.org');
    await db.update(pendingBets).set({ createdAt: old }).where(eq(pendingBets.userId, stale.id));

    // Unconfirmed and old, but re-started today: a sign-up in progress.
    await start('retry@example.org');
    await db.update(user).set({ createdAt: old }).where(eq(user.email, 'retry@example.org'));

    // Unconfirmed and new.
    await start('fresh@example.org');

    // A confirmed trader, and a bot's login-less (unconfirmed) user, both old.
    await signUp('ada@example.org', 'Ada');
    await db.update(user).set({ createdAt: old }).where(eq(user.email, 'ada@example.org'));
    const bot = await createAccount({ handle: 'prune-bot', displayName: 'Bot', isBot: true });
    await mintToken({ account: bot, name: 'bot', scopes: ['read'] });
    await db.update(user).set({ createdAt: old }).where(eq(user.email, 'prune-bot@bots.papermarket.invalid'));

    expect(await pruneUnconfirmedUsers()).toBe(1);
    expect(await userOf('stale@example.org')).toBeUndefined();
    expect(await pendingBetFor(stale.id)).toBeNull();
    for (const kept of [
      'retry@example.org',
      'fresh@example.org',
      'ada@example.org',
      'prune-bot@bots.papermarket.invalid',
    ]) {
      expect(await userOf(kept)).toBeDefined();
    }
  });
});
