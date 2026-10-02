import { and, eq, inArray, ne } from 'drizzle-orm';
import { getDb, type Database } from '@/db';
import { user } from '@/db/auth-schema';
import { accounts, commentAliases, comments, listings, markets } from '@/db/schema';
import { mentionedAliases } from '@/lib/aliases';
import { marketHref } from '@/lib/links';
import { renderMentionMail } from '@/lib/mention-mail';
import { aliasScope } from './comments';
import * as events from './events';
import { sendMail } from './mail';
import { consume, type RateLimitConfig } from './ratelimit';
import { siteName, siteUrl } from './share';

/**
 * Mail the reviewers a comment `@`-mentions (`lib/aliases.ts`): one mail per
 * mentioned alias on the comment's paper, to that account's login address.
 *
 * Not to the author mentioning themself, a bot (its address is never
 * mailed), an account that turned `mention_mail_opt_in` off, or one whose
 * address is unconfirmed. Each recipient has a budget,
 * `mention-mail:<account>`, {@link MENTION_MAIL_BUDGET}: over it the mention
 * still shows on the page and nothing is sent. Without it anyone could fill
 * an inbox by posting `@k3xm` over and over.
 *
 * The mail names the mentioner by alias only, exactly as the page does, so it
 * tells the recipient nothing the discussion doesn't.
 *
 * Called after the comment is committed and never awaited by the request:
 * like `events.log`, a mail failure must never fail the post. Reads, and
 * writes only rate-limit buckets.
 */
export const MENTION_MAIL_BUDGET: RateLimitConfig = { burst: 10, perSecond: 10 / 86_400 };

export async function mailMentions(commentId: string, database: Database = getDb()): Promise<number> {
  const [c] = await database
    .select({
      body: comments.body,
      accountId: comments.accountId,
      marketId: markets.id,
      marketSlug: markets.slug,
      question: markets.question,
      listingId: markets.listingId,
      listingSlug: listings.slug,
      title: listings.title,
    })
    .from(comments)
    .innerJoin(markets, eq(markets.id, comments.marketId))
    .leftJoin(listings, eq(listings.id, markets.listingId))
    .where(eq(comments.id, commentId));
  if (!c) return 0;
  const mentioned = mentionedAliases(c.body);
  if (mentioned.length === 0) return 0;

  const scope = aliasScope({ id: c.marketId, listingId: c.listingId });
  const [author] = await database
    .select({ alias: commentAliases.alias })
    .from(commentAliases)
    .where(and(scope, eq(commentAliases.accountId, c.accountId)));
  if (!author) return 0;

  const recipients = await database
    .select({ accountId: accounts.id, alias: commentAliases.alias, email: user.email })
    .from(commentAliases)
    .innerJoin(accounts, eq(accounts.id, commentAliases.accountId))
    .innerJoin(user, eq(user.id, accounts.userId))
    .where(
      and(
        scope,
        inArray(commentAliases.alias, mentioned),
        ne(commentAliases.accountId, c.accountId),
        eq(accounts.mentionMailOptIn, true),
        eq(accounts.isBot, false),
        eq(accounts.isHouse, false),
        eq(user.emailVerified, true),
      ),
    );

  const base = siteUrl();
  let sent = 0;
  for (const r of recipients) {
    if (!(await consume(`mention-mail:${r.accountId}`, MENTION_MAIL_BUDGET)).allowed) continue;
    const mail = renderMentionMail({
      siteName: siteName(),
      from: author.alias,
      to: r.alias,
      title: c.title ?? c.question,
      body: c.body,
      url: `${base}${marketHref({ marketSlug: c.marketSlug, listingSlug: c.listingSlug })}`,
      settingsUrl: `${base}/profile#email`,
    });
    await sendMail({ to: r.email, ...mail });
    events.log('comment.mention_mailed', { accountId: r.accountId, marketId: c.marketId });
    sent += 1;
  }
  return sent;
}
