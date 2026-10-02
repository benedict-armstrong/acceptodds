import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDb } from '@/db';
import { commentAliases } from '@/db/schema';
import { postComment } from '@/server/comments';
import { createMarket } from '@/server/engine';
import { upsertListing } from '@/server/listings';
import { clearDevOutbox, devOutbox } from '@/server/mail';
import { MENTION_MAIL_BUDGET, mailMentions } from '@/server/mentions';
import { browseListings, marketKinds, sparklines } from '@/server/views';
import { api, trader } from './api-client';
import { closePool, resetDatabase, seedMarket, STARTING_MICRO, type Fixture } from './helpers';

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

const buy = (token: string, outcomeId: string, sharesMicro: string, marketId = fx.marketId) =>
  api('POST', `/markets/${marketId}/orders`, { token, body: { outcomeId, sharesMicro, maxCostMicro: '1000000000' } });

describe('comments', () => {
  it('are anonymous: a stake and a bot flag, never a handle or an account id', async () => {
    const t = await trader('secret-handle');
    await buy(t.token, fx.outcomeIds[0], '40000000');
    const posted = await api('POST', `/markets/${fx.marketId}/comments`, {
      token: t.token,
      body: { body: '  I think so.  ' },
    });
    expect(posted.status).toBe(201);
    expect(posted.body).toMatchObject({
      body: 'I think so.',
      author: { isBot: false, isYou: true, stake: [{ outcomeLabel: 'YES', sharesMicro: '40000000' }] },
    });

    const list = await api('GET', `/markets/${fx.marketId}/comments`);
    expect(list.status).toBe(200);
    expect(list.body.comments[0].author).toEqual({
      alias: posted.body.author.alias,
      isBot: false,
      isYou: false,
      stake: [{ outcomeId: fx.outcomeIds[0], outcomeLabel: 'YES', sharesMicro: '40000000' }],
    });
    const raw = JSON.stringify(list.body);
    expect(raw).not.toContain('secret-handle');
    expect(raw).not.toContain(t.id);
  });

  it('show the current stake, which moves as the author trades', async () => {
    const t = await trader('mover');
    await api('POST', `/markets/${fx.marketId}/comments`, { token: t.token, body: { body: 'no position yet' } });
    expect((await api('GET', `/markets/${fx.marketId}/comments`)).body.comments[0].author.stake).toEqual([]);
    await buy(t.token, fx.outcomeIds[1], '5000000');
    expect((await api('GET', `/markets/${fx.marketId}/comments`)).body.comments[0].author.stake).toEqual([
      { outcomeId: fx.outcomeIds[1], outcomeLabel: 'NO', sharesMicro: '5000000' },
    ]);
  });

  it('flag bots', async () => {
    const bot = await trader('robo', ['read', 'trade'], { isBot: true });
    await api('POST', `/markets/${fx.marketId}/comments`, { token: bot.token, body: { body: 'beep' } });
    expect((await api('GET', `/markets/${fx.marketId}/comments`)).body.comments[0].author.isBot).toBe(true);
  });

  it('need the trade scope and a trading-eligible account, and a sane body', async () => {
    const reader = await trader('reader', ['read']);
    const unverified = await trader('unverified', ['read', 'trade'], { verified: false });
    const ok = await trader('ok');
    expect((await api('POST', `/markets/${fx.marketId}/comments`, { body: { body: 'x' } })).status).toBe(401);
    expect(
      (await api('POST', `/markets/${fx.marketId}/comments`, { token: reader.token, body: { body: 'x' } })).status,
    ).toBe(403);
    const nv = await api('POST', `/markets/${fx.marketId}/comments`, { token: unverified.token, body: { body: 'x' } });
    expect(nv.body.error.code).toBe('not_verified');
    for (const body of ['', '   ', 'x'.repeat(2001)]) {
      const res = await api('POST', `/markets/${fx.marketId}/comments`, { token: ok.token, body: { body } });
      expect(res.status).toBe(400);
    }
    expect((await api('POST', '/markets/nope/comments', { token: ok.token, body: { body: 'x' } })).status).toBe(404);
  });

  it('page newest first without repeats', async () => {
    const t = await trader('chatty');
    for (let i = 0; i < 5; i += 1) {
      await api('POST', `/markets/${fx.marketId}/comments`, { token: t.token, body: { body: `c${i}` } });
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const res: { body: { comments: { body: string }[]; nextCursor: string | null } } = await api(
        'GET',
        `/markets/${fx.marketId}/comments?limit=2${cursor ? `&cursor=${cursor}` : ''}`,
      );
      seen.push(...res.body.comments.map((c) => c.body));
      cursor = res.body.nextCursor;
    } while (cursor);
    expect(seen).toEqual(['c4', 'c3', 'c2', 'c1', 'c0']);
  });
});

describe('aliases', () => {
  const post = (token: string, body: string, marketId = fx.marketId) =>
    api('POST', `/markets/${marketId}/comments`, { token, body: { body } });
  const paperMarket = (listingId: string, slug: string, listingRank: number) =>
    createMarket({
      slug,
      question: `${slug}?`,
      outcomes: ['Accept', 'Reject'],
      startingBalanceMicro: STARTING_MICRO,
      expectedTraders: 10,
      closesAt: new Date(Date.now() + 86_400_000),
      listingId,
      listingRank,
    });

  it('are one per author per paper, across its markets, and differ between authors', async () => {
    const { listing } = await upsertListing({ slug: 'paper', title: 'Paper' });
    const main = await paperMarket(listing.id, 'paper-main', 0);
    const other = await paperMarket(listing.id, 'paper-oral', 1);
    const a = await trader('alice');
    const b = await trader('bob');

    const a1 = (await post(a.token, 'one', main.marketId)).body.author.alias;
    const a2 = (await post(a.token, 'two', other.marketId)).body.author.alias;
    const b1 = (await post(b.token, 'three', main.marketId)).body.author.alias;
    expect(a1).toMatch(/^[a-z2-9]{4}$/);
    expect(a2).toBe(a1);
    expect(b1).not.toBe(a1);

    const list = await api('GET', `/markets/${main.marketId}/comments`, { token: a.token });
    expect(list.body.comments.map((c: { author: { alias: string } }) => c.author.alias)).toEqual([b1, a1]);
    expect(list.body.viewer.alias).toBe(a1);
    // Before commenting on a paper, a viewer has no alias there.
    const elsewhere = await api('GET', `/markets/${fx.marketId}/comments`, { token: a.token });
    expect(elsewhere.body.viewer.alias).toBeNull();
  });

  it('are separate on another paper, and on a market with no listing', async () => {
    const [p, q] = await Promise.all([
      upsertListing({ slug: 'p', title: 'P' }),
      upsertListing({ slug: 'q', title: 'Q' }),
    ]);
    const mp = await paperMarket(p.listing.id, 'mp', 0);
    const mq = await paperMarket(q.listing.id, 'mq', 0);
    const a = await trader('alice');
    await post(a.token, 'on p', mp.marketId);
    await post(a.token, 'on q', mq.marketId);
    await post(a.token, 'unlisted', fx.marketId);
    const rows = await getDb().select().from(commentAliases);
    expect(rows).toHaveLength(3);
    expect(rows.filter((r) => r.marketId === fx.marketId && r.listingId === null)).toHaveLength(1);
  });

  it('are made once when an author posts twice at once', async () => {
    const a = await trader('alice');
    const posted = await Promise.all([1, 2, 3, 4].map((i) => post(a.token, `c${i}`)));
    expect(new Set(posted.map((r) => r.body.author.alias)).size).toBe(1);
    expect(await getDb().select().from(commentAliases)).toHaveLength(1);
  });

  it('resolve @mentions of commenters on the paper only', async () => {
    const a = await trader('alice');
    const b = await trader('bob');
    const alias = (await post(a.token, 'first')).body.author.alias;
    const upper = alias.toUpperCase();
    const reply = await post(b.token, `@${upper} disagree; cc @zzzz and mail x@${alias}`);
    expect(reply.body.mentions).toEqual([alias]);
    const list = await api('GET', `/markets/${fx.marketId}/comments`);
    expect(list.body.comments[0].mentions).toEqual([alias]);
    expect(list.body.comments[1].mentions).toEqual([]);
  });
});

describe('mention mails', () => {
  const createComment = (accountId: string, body: string) => postComment({ marketId: fx.marketId, accountId, body });
  const post = (token: string, body: string, parentId?: string) =>
    api('POST', `/markets/${fx.marketId}/comments`, { token, body: { body, parentId } });
  const mailsTo = (handle: string) => devOutbox().filter((m) => m.to === `${handle}@example.org`);

  beforeEach(() => clearDevOutbox());

  it('mail a mentioned commenter, naming both by alias only, with a link to the discussion', async () => {
    const a = await trader('alice');
    const b = await trader('bob');
    const first = (await post(a.token, 'Strong ablations.')).body;
    const reply = (await post(b.token, `@${first.author.alias} the ablations miss the baseline.`, first.id)).body;

    await vi.waitFor(() => expect(mailsTo('alice')).toHaveLength(1));
    const [mail] = mailsTo('alice');
    expect(mail.subject).toContain(`Reviewer ${reply.author.alias} mentioned you`);
    expect(mail.text).toContain(`(Reviewer ${first.author.alias})`);
    expect(mail.text).toContain('> @');
    expect(mail.text).toContain('/markets/concurrency');
    expect(mail.text).not.toContain('bob');
    expect(mailsTo('bob')).toHaveLength(0);
  });

  it('never mail the author, an unknown alias, a bot, or anyone who opted out', async () => {
    const a = await trader('alice');
    const bot = await trader('robo', ['read', 'trade'], { isBot: true });
    const quiet = await trader('quiet');
    const self = (await post(a.token, 'mine')).body.author.alias;
    const botAlias = (await post(bot.token, 'beep')).body.author.alias;
    const quietAlias = (await post(quiet.token, 'shh')).body.author.alias;
    expect((await api('PATCH', '/me', { token: quiet.token, body: { mentionMailOptIn: false } })).body).toMatchObject({
      mentionMailOptIn: false,
      digestOptIn: true,
    });

    const c = await post(a.token, `@${self} @${botAlias} @${quietAlias} @zzzz`);
    expect(await mailMentions(c.body.id)).toBe(0);
    expect(devOutbox()).toHaveLength(0);
  });

  it('stop at the daily budget per recipient', async () => {
    const a = await trader('alice');
    const b = await trader('bob');
    const alias = (await post(a.token, 'hello')).body.author.alias;
    const ids: string[] = [];
    for (let i = 0; i < MENTION_MAIL_BUDGET.burst + 2; i += 1) {
      ids.push((await createComment(b.id, `@${alias} ${i}`)).id);
    }
    let sent = 0;
    for (const id of ids) sent += await mailMentions(id);
    expect(sent).toBe(MENTION_MAIL_BUDGET.burst);
  });
});

describe('replies', () => {
  const post = (token: string, body: string, parentId?: string, marketId = fx.marketId) =>
    api('POST', `/markets/${marketId}/comments`, { token, body: { body, parentId } });
  type C = { id: string; body: string; parentId: string | null; replyCount: number };
  const bodies = (cs: C[]) => cs.map((c) => c.body);

  it('nest: a reply to a reply stays under it', async () => {
    const t = await trader('threader');
    const root = (await post(t.token, 'root')).body;
    expect(root).toMatchObject({ parentId: null, replyCount: 0 });
    const reply = await post(t.token, 'reply', root.id);
    expect(reply.status).toBe(201);
    expect(reply.body.parentId).toBe(root.id);
    const nested = (await post(t.token, 'reply to the reply', reply.body.id)).body;
    expect(nested.parentId).toBe(reply.body.id);

    const list = await api('GET', `/markets/${fx.marketId}/comments`);
    expect(list.body.total).toBe(3);
    expect(bodies(list.body.comments)).toEqual(['root']);
    expect(list.body.comments[0].replyCount).toBe(1);
    expect(list.body.replies.map((c: C) => [c.body, c.parentId, c.replyCount])).toEqual([
      ['reply', root.id, 1],
      ['reply to the reply', reply.body.id, 0],
    ]);
  });

  it('refuse a parent on another market, or none at all', async () => {
    const other = await createMarket({
      slug: 'other',
      question: 'other',
      kind: 'binary',
      outcomes: ['YES', 'NO'],
      closesAt: new Date(Date.now() + 86_400_000),
      startingBalanceMicro: STARTING_MICRO,
      expectedTraders: 10,
    });
    const t = await trader('stray');
    const elsewhere = (await post(t.token, 'elsewhere', undefined, other.marketId)).body;
    expect((await post(t.token, 'x', elsewhere.id)).status).toBe(404);
    expect((await post(t.token, 'x', '00000000-0000-4000-8000-000000000000')).status).toBe(404);
    expect((await post(t.token, 'x', 'not-a-uuid')).status).toBe(400);
  });

  it('preview three per comment, three levels down', async () => {
    const t = await trader('deep');
    const root = (await post(t.token, 'root')).body;
    for (let i = 0; i < 5; i += 1) await post(t.token, `a${i}`, root.id);
    // A chain five deep under the first reply.
    let parent = (await api('GET', `/comments/${root.id}/replies?limit=1`)).body.replies[0];
    for (let d = 2; d <= 5; d += 1) parent = (await post(t.token, `d${d}`, parent.id)).body;

    const list = await api('GET', `/markets/${fx.marketId}/comments`);
    expect(list.body.total).toBe(10);
    expect(list.body.comments[0].replyCount).toBe(5);
    expect(bodies(list.body.replies)).toEqual(['a0', 'a1', 'a2', 'd2', 'd3']);
  });

  it('page the rest after the last one loaded, without repeats', async () => {
    const t = await trader('busy');
    const root = (await post(t.token, 'root')).body;
    for (let i = 0; i < 8; i += 1) await post(t.token, `r${i}`, root.id);
    await post(t.token, 'later root');

    const list = await api('GET', `/markets/${fx.marketId}/comments`);
    expect(bodies(list.body.comments)).toEqual(['later root', 'root']);
    const seen: C[] = list.body.replies;
    expect(bodies(seen)).toEqual(['r0', 'r1', 'r2']);
    while (seen.length < 8) {
      const res = await api('GET', `/comments/${root.id}/replies?limit=2&after=${seen.at(-1)!.id}`);
      expect(res.status).toBe(200);
      seen.push(...res.body.replies);
    }
    expect(bodies(seen)).toEqual(['r0', 'r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7']);
    expect((await api('GET', `/comments/${root.id}/replies?after=${seen.at(-1)!.id}`)).body.replies).toEqual([]);

    expect((await api('GET', `/comments/${root.id}/replies?after=${root.id}`)).status).toBe(400);
    expect((await api('GET', '/comments/00000000-0000-4000-8000-000000000000/replies')).status).toBe(404);
  });

  it('come with a preview of the replies under each page of them', async () => {
    const t = await trader('fork');
    const root = (await post(t.token, 'root')).body;
    const a = (await post(t.token, 'a', root.id)).body;
    const b = (await post(t.token, 'a.b', a.id)).body;
    await post(t.token, 'a.b.c', b.id);
    const res = await api('GET', `/comments/${root.id}/replies`);
    expect(res.body.replies.map((c: C) => [c.body, c.parentId])).toEqual([
      ['a', root.id],
      ['a.b', a.id],
      ['a.b.c', b.id],
    ]);
  });

  it('are left out of the top level in either sort, and can be backed', async () => {
    const author = await trader('author');
    const backer = await trader('backer');
    await buy(backer.token, fx.outcomeIds[0], '10000000');
    const root = (await post(author.token, 'root')).body;
    const reply = (await post(author.token, 'reply', root.id)).body;
    const backed = await api('POST', `/comments/${reply.id}/backing`, {
      token: backer.token,
      body: { outcomeId: fx.outcomeIds[0], sharesMicro: '5000000' },
    });
    expect(backed.status).toBe(201);
    const relevance = await api('GET', `/markets/${fx.marketId}/comments?sort=relevance`);
    expect(relevance.body.comments.map((c: C) => c.id)).toEqual([root.id]);
    expect(relevance.body.replies[0].backing.backers).toBe(1);
  });
});

describe('browsing markets', () => {
  async function extra(slug: string, kind: string, closesInDays: number) {
    return createMarket({
      slug,
      question: slug,
      kind,
      outcomes: ['YES', 'NO'],
      closesAt: new Date(Date.now() + closesInDays * 86_400_000),
      startingBalanceMicro: STARTING_MICRO,
      expectedTraders: 10,
    });
  }

  it('filters by kind and status, and sorts by closing, volume, activity and newest', async () => {
    const a = await extra('a', 'ICLR 2027', 30);
    const b = await extra('b', 'ICLR 2027', 10);
    const c = await extra('c', 'NeurIPS 2026', 5);
    const t = await trader('t');
    await buy(t.token, a.outcomeIds[0], '50000000', a.marketId); // most volume
    await buy(t.token, b.outcomeIds[0], '5000000', b.marketId); // most recent

    const slugs = async (q: Parameters<typeof browseListings>[0]) =>
      (await browseListings(q)).rows.map((r) => r.market.slug);
    expect(await slugs({ kind: 'ICLR 2027', sort: 'closing' })).toEqual(['b', 'a']);
    expect(await slugs({ kind: 'ICLR 2027', sort: 'volume' })).toEqual(['a', 'b']);
    expect(await slugs({ kind: 'ICLR 2027', sort: 'activity' })).toEqual(['b', 'a']);
    expect(await slugs({ kind: 'ICLR 2027', sort: 'newest' })).toEqual(['b', 'a']);
    expect(await slugs({ kind: null, sort: 'closing' })).toEqual(['concurrency', 'c', 'b', 'a']);
    expect(await slugs({ kind: 'NeurIPS 2026', status: 'settled', sort: 'closing' })).toEqual([]);
    void c;

    expect(await marketKinds()).toEqual([
      { kind: 'ICLR 2027', count: 2 },
      { kind: 'NeurIPS 2026', count: 1 },
      { kind: 'binary', count: 1 },
    ]);
  });

  it('builds sparklines from real fills only', async () => {
    const t = await trader('s');
    await buy(t.token, fx.outcomeIds[0], '10000000');
    await buy(t.token, fx.outcomeIds[1], '30000000');
    const { rows } = await browseListings({ kind: null, sort: 'closing' });
    const sp = await sparklines(rows);
    const line = sp.get(fx.marketId)!;
    expect(line).toHaveLength(3);
    expect(line[0]).toBe(0.5); // the opening price
    expect(line[1]).toBeGreaterThan(0.5); // YES bought
    expect(line[2]).toBeLessThan(line[1]); // then NO bought
    expect(line[2]).toBeCloseTo(rows[0].outcomes[0].price, 12);
  });
});
