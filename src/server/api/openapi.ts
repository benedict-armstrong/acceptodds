import { OpenAPIRegistry, OpenApiGeneratorV31, type RouteConfig } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import { MAX_GROUPS_PER_ADMIN } from '../groups';
import * as S from './schemas';

/**
 * The OpenAPI 3.1 document for `/api/v1`, generated from the same Zod schemas
 * the handlers parse and validate with. Nothing here is hand-written JSON
 * Schema; a hand-maintained doc rots.
 *
 * When you add or change an endpoint, change it here too — the integration
 * test checks that every route file under `app/api/v1` has an operation here
 * and that the document validates.
 */

type Scope = 'read' | 'trade' | 'admin';

const json = <T extends z.ZodType>(schema: T, description: string) => ({
  description,
  content: { 'application/json': { schema } },
});

const err = (description: string) => json(S.ErrorResponse, description);

const RATE_LIMIT_HEADERS = {
  'X-RateLimit-Limit': { description: 'Bucket size, in requests.', schema: { type: 'integer' as const } },
  'X-RateLimit-Remaining': { description: 'Requests left in the bucket.', schema: { type: 'integer' as const } },
  'X-RateLimit-Reset': { description: 'Seconds until the bucket is full.', schema: { type: 'integer' as const } },
};

const idParam = z.object({ id: S.MarketRef });

function op(
  config: Omit<RouteConfig, 'responses'> & {
    ok: { status: 200 | 201; schema: z.ZodType; description: string };
    scope?: Scope;
    errors?: Partial<Record<400 | 401 | 403 | 404 | 409 | 422 | 429, string>>;
  },
): RouteConfig {
  const { ok, scope, errors = {}, ...rest } = config;
  const responses: RouteConfig['responses'] = {
    [ok.status]: { ...json(ok.schema, ok.description), headers: RATE_LIMIT_HEADERS },
  };
  const all = {
    400: 'validation_error: the request did not match the schema.',
    ...(scope
      ? {
          401: 'unauthorized: missing, malformed or revoked token.',
          403: `forbidden: the token lacks the "${scope}" scope.`,
        }
      : { 401: 'unauthorized: a token was sent and it is invalid. (No token at all is fine.)' }),
    429: 'rate_limited: this token’s bucket is empty. See Retry-After.',
    ...errors,
  };
  for (const [status, description] of Object.entries(all)) {
    responses[status] = {
      ...err(description),
      ...(status === '429'
        ? { headers: { ...RATE_LIMIT_HEADERS, 'Retry-After': { schema: { type: 'integer' as const } } } }
        : {}),
    };
  }
  return {
    ...rest,
    // A session may read and trade; admin only if its email is in ADMIN_EMAILS.
    security: scope ? [{ bearer: [scope] }, { session: [] }] : [{}, { bearer: [] }, { session: [] }],
    responses,
  };
}

export function buildRegistry(): OpenAPIRegistry {
  const r = new OpenAPIRegistry();

  r.registerComponent('securitySchemes', 'session', {
    type: 'apiKey',
    in: 'cookie',
    name: 'better-auth.session_token',
    description:
      'A signed-in browser session (sign up and sign in at /api/auth, with an email address at an approved institution). Equivalent to the `read` and `trade` scopes, plus `admin` if your email is in the server’s `ADMIN_EMAILS`. Writes must come from our own Origin.',
  });

  r.registerComponent('securitySchemes', 'bearer', {
    type: 'http',
    scheme: 'bearer',
    description:
      'An API token, `pm_live_…`. Scopes: `read` (me endpoints), `trade` (placing orders), `admin` (creating, closing and settling markets). No scope implies another. Every request made with a token counts against that token’s rate-limit bucket.',
  });

  // -- public ---------------------------------------------------------------

  r.registerPath(
    op({
      method: 'get',
      path: '/markets',
      tags: ['markets'],
      summary: 'List markets',
      description:
        'Newest first. Drafts are hidden unless `status=draft`. With `q`, only markets whose question or description — or whose listing’s title, authors or summary — match, best match first.',
      request: { query: S.MarketListQuery },
      ok: { status: 200, schema: S.MarketList, description: 'A page of markets.' },
    }),
  );

  r.registerPath(
    op({
      method: 'get',
      path: '/markets/{id}',
      tags: ['markets'],
      summary: 'Market board',
      description: 'Outcomes, prices, volume and the frozen liquidity parameter `b`.',
      request: { params: idParam },
      ok: { status: 200, schema: S.Market, description: 'The board.' },
      errors: { 404: 'not_found' },
    }),
  );

  r.registerPath(
    op({
      method: 'get',
      path: '/markets/{id}/history',
      tags: ['markets'],
      summary: 'Price history',
      description: 'Every outcome’s price after every fill, oldest first, reconstructed from the fills.',
      request: { params: idParam, query: S.PaginationQuery },
      ok: { status: 200, schema: S.PriceHistory, description: 'A page of price points.' },
      errors: { 404: 'not_found' },
    }),
  );

  r.registerPath(
    op({
      method: 'get',
      path: '/markets/{id}/orders',
      tags: ['markets'],
      summary: 'Public tape',
      description: 'Fills on this market, newest first. Carries no account identities.',
      request: { params: idParam, query: S.PaginationQuery },
      ok: { status: 200, schema: S.Tape, description: 'A page of fills.' },
      errors: { 404: 'not_found' },
    }),
  );

  r.registerPath(
    op({
      method: 'post',
      path: '/markets/{id}/quote',
      tags: ['trading'],
      summary: 'Quote a hypothetical trade',
      description:
        'Prices the whole size, slippage included. Writes nothing. Advisory: an order is re-priced under the market lock, so pass the quoted cost as `maxCostMicro`.',
      request: { params: idParam, body: { content: { 'application/json': { schema: S.QuoteRequest } } } },
      ok: { status: 200, schema: S.Quote, description: 'The quote.' },
      errors: { 404: 'not_found: no such market or outcome.' },
    }),
  );

  r.registerPath(
    op({
      method: 'get',
      path: '/listings',
      tags: ['listings'],
      summary: 'List listings',
      description:
        'Newest first. A listing is an opaque subject that markets are grouped under; each comes with its markets, main market first. With `q`, only listings whose title, authors or summary — or any of whose visible markets’ question or description — match, best match first.',
      request: { query: S.ListingListQuery },
      ok: { status: 200, schema: S.ListingList, description: 'A page of listings.' },
    }),
  );

  r.registerPath(
    op({
      method: 'get',
      path: '/listings/{id}',
      tags: ['listings'],
      summary: 'A listing and its markets',
      description: 'Markets are ordered by `listingRank`; the first is the main market. Drafts are left out.',
      request: { params: z.object({ id: S.ListingRef }) },
      ok: { status: 200, schema: S.Listing, description: 'The listing.' },
      errors: { 404: 'not_found' },
    }),
  );

  r.registerPath(
    op({
      method: 'get',
      path: '/leaderboard',
      tags: ['accounts'],
      summary: 'Leaderboard',
      description: `Every entry carries settled (realized) P&L, liquidation net worth and unrealized P&L; \`basis\` picks the ranking. ${S.LEADERBOARD_BASIS_DESCRIPTION} \`institution\` ranks one institution among itself, \`group\` one group; \`q\` finds traders by name and keeps their rank.`,
      request: { query: S.LeaderboardQuery },
      ok: { status: 200, schema: S.Leaderboard, description: 'A page of the leaderboard.' },
    }),
  );

  r.registerPath(
    op({
      method: 'get',
      path: '/accounts/{handle}',
      tags: ['accounts'],
      summary: 'Public profile',
      request: { params: z.object({ handle: S.Handle }) },
      ok: { status: 200, schema: S.PublicAccount, description: 'Institution and settled record.' },
      errors: { 404: 'not_found' },
    }),
  );

  r.registerPath(
    op({
      method: 'get',
      path: '/accounts/{handle}/positions',
      tags: ['accounts'],
      summary: 'Public positions',
      description:
        'Only the positions this trader chose to make public, newest first, each read live. Nothing else about anyone’s positions is public.',
      request: { params: z.object({ handle: S.Handle }) },
      ok: { status: 200, schema: S.PublicPositionList, description: 'Their public positions.' },
      errors: { 404: 'not_found' },
    }),
  );

  r.registerPath(
    op({
      method: 'get',
      path: '/positions/{id}',
      tags: ['accounts'],
      summary: 'A public position',
      description:
        'A position its holder made public, by its link id: held, sold or settled now, with the exit quote while trading (never a mark). 404 once made private.',
      request: { params: z.object({ id: S.Id }) },
      ok: { status: 200, schema: S.PublicPosition, description: 'The position, now.' },
      errors: { 404: 'not_found' },
    }),
  );

  r.registerPath(
    op({
      method: 'get',
      path: '/markets/{id}/comments',
      tags: ['markets'],
      summary: 'Comments',
      description:
        'Top-level comments, newest first, or by backing with `sort=relevance`, with a preview of the replies under them in `replies` (the rest from `GET /comments/{id}/replies`). Anonymous: each comment shows only whether its author is a bot, their current stake in this market, and how much stake others have put behind it (never by whom). Bodies are raw Markdown with TeX math.',
      request: { params: idParam, query: S.CommentListQuery },
      ok: { status: 200, schema: S.CommentList, description: 'A page of comments.' },
      errors: { 404: 'not_found' },
    }),
  );

  r.registerPath(
    op({
      method: 'post',
      path: '/markets/{id}/comments',
      tags: ['markets'],
      summary: 'Post a comment',
      description:
        'With `parentId`, a reply. Needs the `trade` scope and a trading-eligible (verified or bot) account.',
      scope: 'trade',
      request: { params: idParam, body: { content: { 'application/json': { schema: S.CommentRequest } } } },
      ok: { status: 201, schema: S.Comment, description: 'The comment, as others will see it.' },
      errors: {
        403: 'forbidden | not_verified',
        404: 'not_found: no such market, or `parentId` is not a comment on it.',
      },
    }),
  );

  const commentIdParam = z.object({ id: S.CommentId });

  r.registerPath(
    op({
      method: 'get',
      path: '/comments/{id}/replies',
      tags: ['markets'],
      summary: 'Replies to a comment',
      description:
        'Direct replies, oldest first, after `after` (the last one loaded), each with a preview of the replies under it. Replies nest to any depth.',
      request: { params: commentIdParam, query: S.CommentRepliesQuery },
      ok: { status: 200, schema: S.CommentReplies, description: 'A page of replies.' },
      errors: { 400: 'validation_error: `after` is not a reply to this comment.', 404: 'not_found' },
    }),
  );

  r.registerPath(
    op({
      method: 'post',
      path: '/comments/{id}/backing',
      tags: ['trading'],
      summary: 'Back a comment with shares',
      description:
        "Puts `sharesMicro` of an outcome you hold behind someone else's comment on an open market. No reputation moves; the shares stay in your position. Across all comments, what you back on an outcome never exceeds what you hold of it: selling trims your backings newest first, and buying back does not restore them. Needs the `trade` scope and a trading-eligible account.",
      scope: 'trade',
      request: {
        params: commentIdParam,
        body: { content: { 'application/json': { schema: S.CommentBackingRequest } } },
      },
      ok: { status: 201, schema: S.Comment, description: 'The comment, with its updated backing.' },
      errors: {
        403: 'forbidden | not_verified',
        404: "not_found: no such comment, or the outcome is not on the comment's market.",
        409: 'insufficient_stake | own_comment | market_not_open | market_closed',
      },
    }),
  );

  const unback = op({
    method: 'delete',
    path: '/comments/{id}/backing',
    tags: ['trading'],
    summary: 'Withdraw your backing from a comment',
    description: 'Removes all of your backing from this comment. Idempotent.',
    scope: 'trade',
    request: { params: commentIdParam },
    ok: { status: 200, schema: S.Comment, description: 'unused' },
    errors: { 403: 'forbidden | not_verified', 404: 'not_found' },
  });
  delete unback.responses[200];
  unback.responses[204] = { description: 'Withdrawn (or there was nothing to withdraw).' };
  r.registerPath(unback);

  // -- authenticated --------------------------------------------------------

  r.registerPath(
    op({
      method: 'post',
      path: '/markets/{id}/orders',
      tags: ['trading'],
      summary: 'Place an order (buy, or sell with negative shares)',
      description:
        'Selling is an order with negative `sharesMicro`; you may only sell shares you hold. Send an `Idempotency-Key` header and retry freely: a retry with the same key returns the original fill with `replayed: true`.',
      scope: 'trade',
      request: {
        params: idParam,
        headers: z.object({
          'Idempotency-Key': S.IdempotencyKey.optional().meta({
            description: 'Up to 255 printable ASCII characters, unique per account.',
          }),
        }),
        body: { content: { 'application/json': { schema: S.OrderRequest } } },
      },
      ok: { status: 201, schema: S.Fill, description: 'The fill (or, for a replayed key, the original fill).' },
      errors: {
        403: 'forbidden: the credential lacks the "trade" scope | not_verified: the account has no confirmed institutional email address.',
        404: 'not_found: no such market or outcome.',
        409: 'slippage_exceeded | insufficient_balance | insufficient_shares | market_not_open | market_closed | idempotency_key_reused',
      },
    }),
  );

  r.registerPath(
    op({
      method: 'get',
      path: '/me',
      tags: ['me'],
      summary: 'The authenticated account',
      scope: 'read',
      ok: { status: 200, schema: S.Me, description: 'Account and balance.' },
    }),
  );

  r.registerPath(
    op({
      method: 'get',
      path: '/me/portfolio',
      tags: ['me'],
      summary: 'Holdings',
      description:
        'Each holding carries its **mark** (shares × price) and its **quoted exit value** (what selling it all now would pay) as separate fields. They differ, and only the second is a sale price. `summary` gives cash, liquidation net worth, and unrealized and realized P&L.',
      scope: 'read',
      ok: { status: 200, schema: S.Portfolio, description: 'The portfolio.' },
    }),
  );

  r.registerPath(
    op({
      method: 'get',
      path: '/me/orders',
      tags: ['me'],
      summary: 'Own fills',
      scope: 'read',
      request: { query: S.PaginationQuery },
      ok: { status: 200, schema: S.MyOrders, description: 'A page of your fills, newest first.' },
    }),
  );

  r.registerPath(
    op({
      method: 'patch',
      path: '/me',
      tags: ['me'],
      summary: 'Update your settings',
      description: 'Currently only `digestOptIn`: the daily email about followed papers whose price moved.',
      scope: 'read',
      request: { body: { content: { 'application/json': { schema: S.UpdateMeRequest } } } },
      ok: { status: 200, schema: S.Me, description: 'The account, updated.' },
    }),
  );

  r.registerPath(
    op({
      method: 'get',
      path: '/me/follows',
      tags: ['me'],
      summary: 'Listings you follow',
      description:
        'Each with its main market’s headline price now and 24 hours ago (replayed from the fills). Prices, not values.',
      scope: 'read',
      ok: { status: 200, schema: S.FollowList, description: 'Your follows, most recent first.' },
    }),
  );

  const groupIdParam = z.object({ id: S.Id });
  const noContent = (config: Parameters<typeof op>[0], description: string): RouteConfig => {
    const c = op(config);
    delete c.responses[config.ok.status];
    c.responses[204] = { description };
    return c;
  };

  r.registerPath(
    op({
      method: 'get',
      path: '/me/groups',
      tags: ['groups'],
      summary: 'Your groups',
      scope: 'read',
      ok: { status: 200, schema: S.GroupList, description: 'Every group you are in, with its invite code.' },
    }),
  );

  r.registerPath(
    op({
      method: 'post',
      path: '/groups',
      tags: ['groups'],
      summary: 'Make a group',
      description: `You become its admin and first member. Share its invite code for others to join. At most ${MAX_GROUPS_PER_ADMIN} groups per admin.`,
      scope: 'read',
      request: { body: { content: { 'application/json': { schema: S.CreateGroupRequest } } } },
      ok: { status: 201, schema: S.Group, description: 'The new group.' },
      errors: { 400: 'validation_error', 409: 'too_many_groups' },
    }),
  );

  r.registerPath(
    op({
      method: 'get',
      path: '/groups/{id}',
      tags: ['groups'],
      summary: 'A group',
      description:
        'Its members, each with their institutions. Public by id; the invite code only to members. Rank the group with `GET /leaderboard?group={id}`.',
      request: { params: groupIdParam },
      ok: { status: 200, schema: S.Group, description: 'The group.' },
      errors: { 404: 'not_found' },
    }),
  );

  r.registerPath(
    op({
      method: 'patch',
      path: '/groups/{id}',
      tags: ['groups'],
      summary: 'Rename a group',
      description: 'Its name or description. Admin only.',
      scope: 'read',
      request: { params: groupIdParam, body: { content: { 'application/json': { schema: S.UpdateGroupRequest } } } },
      ok: { status: 200, schema: S.Group, description: 'The group.' },
      errors: {
        403: 'forbidden: the token lacks the "read" scope, or you are not the group’s admin.',
        400: 'validation_error',
        404: 'not_found',
      },
    }),
  );

  r.registerPath(
    noContent(
      {
        method: 'delete',
        path: '/groups/{id}',
        tags: ['groups'],
        summary: 'Delete a group',
        description: 'Admin only. Every membership goes with it.',
        scope: 'read',
        request: { params: groupIdParam },
        ok: { status: 200, schema: S.Group, description: 'unused' },
        errors: {
          403: 'forbidden: the token lacks the "read" scope, or you are not the group’s admin.',
          404: 'not_found',
        },
      },
      'Deleted.',
    ),
  );

  r.registerPath(
    op({
      method: 'post',
      path: '/groups/{id}/invite',
      tags: ['groups'],
      summary: 'Rotate the invite code',
      description: 'Admin only. The old invite link stops working; members stay.',
      scope: 'read',
      request: { params: groupIdParam },
      ok: { status: 200, schema: S.Group, description: 'The group, with its new code.' },
      errors: {
        403: 'forbidden: the token lacks the "read" scope, or you are not the group’s admin.',
        404: 'not_found',
      },
    }),
  );

  r.registerPath(
    op({
      method: 'post',
      path: '/groups/join',
      tags: ['groups'],
      summary: 'Join a group',
      description: 'By its current invite code. Idempotent.',
      scope: 'read',
      request: { body: { content: { 'application/json': { schema: S.JoinGroupRequest } } } },
      ok: { status: 200, schema: S.Group, description: 'The group you are now in.' },
      errors: { 400: 'validation_error', 404: 'not_found: no group has this code (it may have been rotated).' },
    }),
  );

  r.registerPath(
    noContent(
      {
        method: 'delete',
        path: '/groups/{id}/members/{handle}',
        tags: ['groups'],
        summary: 'Leave a group, or remove a member',
        description:
          'Your own handle leaves the group; the admin may remove anyone else. The admin cannot leave: they delete the group instead. Idempotent for someone not in it.',
        scope: 'read',
        request: { params: z.object({ id: S.Id, handle: S.Handle }) },
        ok: { status: 200, schema: S.Group, description: 'unused' },
        errors: {
          403: 'forbidden: the token lacks the "read" scope, or you are not the group’s admin.',
          404: 'not_found',
          409: 'group_admin: the admin cannot be removed.',
        },
      },
      'Removed.',
    ),
  );

  const listingIdParam = z.object({ id: S.ListingRef });
  for (const method of ['put', 'delete'] as const) {
    r.registerPath(
      op({
        method,
        path: '/listings/{id}/follow',
        tags: ['listings'],
        summary: method === 'put' ? 'Follow a listing' : 'Unfollow a listing',
        description:
          'Idempotent. A follow moves no money and needs only the `read` scope; followers may get a daily email when the listing’s main market moves (opt out with `PATCH /me`). Only listings can be followed.',
        scope: 'read',
        request: { params: listingIdParam },
        ok: { status: 200, schema: S.FollowState, description: 'Whether you now follow it, and its follower count.' },
        errors: { 404: 'not_found' },
      }),
    );
  }

  for (const method of ['put', 'delete'] as const) {
    r.registerPath(
      op({
        method,
        path: '/me/positions/{outcomeId}/public',
        tags: ['me'],
        summary: method === 'put' ? 'Make a position public' : 'Make a position private',
        description:
          method === 'put'
            ? 'Gives your position in this outcome a public link and lists it on your public profile, under your handle. Your comments on that market show your stake, so this links them to you. Only a position you hold. Idempotent: the link stays the same.'
            : 'Removes it from your profile; its link stops working. Idempotent.',
        scope: 'trade',
        request: { params: z.object({ outcomeId: S.Id }) },
        ok: { status: 200, schema: S.PublicPositionState, description: 'Its link id while public, else null.' },
        errors: method === 'put' ? { 409: 'insufficient_shares: you hold no shares of this outcome.' } : {},
      }),
    );
  }

  const sessionOnly = (config: Parameters<typeof op>[0]): RouteConfig => ({
    ...op({
      ...config,
      errors: {
        401: 'unauthorized: not signed in.',
        403: 'session_required: called with an API token. These endpoints never accept one.',
        ...config.errors,
      },
    }),
    security: [{ session: [] }],
  });

  r.registerPath(
    sessionOnly({
      method: 'post',
      path: '/me/tokens',
      tags: ['me'],
      summary: 'Mint an API token',
      description:
        'Scopes `read` and/or `trade`. The token is returned once and never again. `admin` tokens are issued by an operator only.',
      request: { body: { content: { 'application/json': { schema: S.CreateTokenRequest } } } },
      ok: { status: 201, schema: S.CreatedToken, description: 'The token, shown once.' },
    }),
  );

  r.registerPath(
    sessionOnly({
      method: 'get',
      path: '/me/tokens',
      tags: ['me'],
      summary: 'List your API tokens',
      ok: { status: 200, schema: S.TokenList, description: 'Your tokens, newest first, without their secrets.' },
    }),
  );

  const revoke = sessionOnly({
    method: 'delete',
    path: '/me/tokens/{id}',
    tags: ['me'],
    summary: 'Revoke an API token',
    request: { params: z.object({ id: S.TokenId }) },
    ok: { status: 200, schema: S.TokenList, description: 'unused' },
    errors: { 404: 'not_found' },
  });
  delete revoke.responses[200];
  revoke.responses[204] = { description: 'Revoked. The token stops working immediately.' };
  r.registerPath(revoke);

  const affiliationIdParam = z.object({ id: S.AffiliationId });

  r.registerPath(
    sessionOnly({
      method: 'get',
      path: '/me/affiliations',
      tags: ['me'],
      summary: 'List your affiliations',
      description:
        'Your institutional email addresses, confirmed and pending: the one you signed up with first. The institutions of the confirmed ones are your `institutions`.',
      ok: { status: 200, schema: S.AffiliationList, description: 'Your affiliations.' },
    }),
  );

  r.registerPath(
    sessionOnly({
      method: 'post',
      path: '/me/affiliations',
      tags: ['me'],
      summary: 'Add an affiliation',
      description:
        'Mails a 6-digit code to an address at an approved institution; confirm it with `POST /me/affiliations/{id}/verify` within an hour. Adding a pending address again sends a fresh code, and only the newest works. Each call costs one of 10 affiliation emails a day. An address another account has confirmed answers the same, but its owner is told instead and no code is sent.',
      request: { body: { content: { 'application/json': { schema: S.AddAffiliationRequest } } } },
      ok: { status: 201, schema: S.Affiliation, description: 'The pending affiliation.' },
      errors: {
        409: `already_affiliated: the address is already one of yours | too_many_pending: at most 5 unconfirmed at once.`,
        422: 'email_domain_not_allowed: the domain is not on the institution allowlist.',
        429: 'rate_limited: your bucket is empty, or you have used your 10 affiliation emails (one back every 2.4 hours). See Retry-After.',
      },
    }),
  );

  r.registerPath(
    sessionOnly({
      method: 'post',
      path: '/me/affiliations/{id}/verify',
      tags: ['me'],
      summary: 'Confirm an affiliation',
      description:
        'With the code mailed to the address. Confirming one already confirmed returns it. After five wrong codes only a fresh code works.',
      request: {
        params: affiliationIdParam,
        body: { content: { 'application/json': { schema: S.VerifyAffiliationRequest } } },
      },
      ok: { status: 200, schema: S.Affiliation, description: 'The confirmed affiliation.' },
      errors: {
        404: 'not_found',
        409: 'affiliation_taken: another account confirmed this address first.',
        422: 'invalid_code: wrong, expired, or too many attempts (`details.reason`) | email_domain_not_allowed: the domain has left the allowlist.',
      },
    }),
  );

  const unaffiliate = sessionOnly({
    method: 'delete',
    path: '/me/affiliations/{id}',
    tags: ['me'],
    summary: 'Remove an affiliation',
    description:
      'Pending or confirmed; never the address you signed up with. Removing your last confirmed one stops you trading.',
    request: { params: affiliationIdParam },
    ok: { status: 200, schema: S.AffiliationList, description: 'unused' },
    errors: { 404: 'not_found', 409: 'primary_affiliation: the address you signed up with.' },
  });
  delete unaffiliate.responses[200];
  unaffiliate.responses[204] = { description: 'Removed.' };
  r.registerPath(unaffiliate);

  r.registerPath(
    sessionOnly({
      method: 'post',
      path: '/me/password',
      tags: ['me'],
      summary: 'Set your first password',
      description:
        'For an account made by onboarding (`POST /onboarding`), which has none. To change a password, reset it from the sign-in page.',
      request: { body: { content: { 'application/json': { schema: S.SetPasswordRequest } } } },
      ok: { status: 200, schema: S.PasswordSet, description: 'Set. Sign in with it from now on.' },
      errors: { 409: 'password_already_set' },
    }),
  );

  const dropPendingBet = sessionOnly({
    method: 'delete',
    path: '/me/pending-bet',
    tags: ['me'],
    summary: 'Drop your onboarding bet',
    description:
      'The bet chosen during onboarding, once placed through `POST /markets/{id}/orders` or declined. Idempotent.',
    ok: { status: 200, schema: S.PasswordSet, description: 'unused' },
  });
  delete dropPendingBet.responses[200];
  dropPendingBet.responses[204] = { description: 'Dropped (or there was none).' };
  r.registerPath(dropPendingBet);

  r.registerPath(
    op({
      method: 'post',
      path: '/onboarding',
      tags: ['onboarding'],
      summary: 'Sign up by choosing a bet',
      description:
        'Makes a password-less sign-up for an address at an approved institution and mails it a confirmation link and code. The bet is stored, not placed: no account exists until the address is confirmed. After confirming, the person sets a password (`POST /me/password`) and places the bet like any order, at the price then. Answers the same whether or not the address already has an account; a confirmed one is mailed a note to sign in instead, and its bet dropped. Five mails a day per address.',
      request: { body: { content: { 'application/json': { schema: S.OnboardingRequest } } } },
      ok: { status: 200, schema: S.SignUpStarted, description: 'The mail is on its way.' },
      errors: {
        404: 'not_found: no such market or outcome.',
        409: 'market_not_open | market_closed',
        422: 'email_domain_not_allowed: the domain is not on the institution allowlist.',
        429: 'rate_limited: too many sign-up mails to this address. See Retry-After.',
      },
    }),
  );

  r.registerPath(
    op({
      method: 'post',
      path: '/signup',
      tags: ['onboarding'],
      summary: 'Sign up',
      description:
        'Makes a password-less sign-up for an address at an approved institution and mails it a confirmation link and code. No password is taken here: it is chosen after confirming, so nobody can attach one to an address they have not proven. Answers the same whether or not the address already has an account; a confirmed one is mailed a note instead. Five mails a day per address, shared with `POST /onboarding`.',
      request: { body: { content: { 'application/json': { schema: S.SignUpRequest } } } },
      ok: { status: 200, schema: S.SignUpStarted, description: 'The mail is on its way.' },
      errors: {
        422: 'email_domain_not_allowed: the domain is not on the institution allowlist.',
        429: 'rate_limited: too many sign-up mails to this address. See Retry-After.',
      },
    }),
  );

  // -- admin ----------------------------------------------------------------

  r.registerPath(
    op({
      method: 'post',
      path: '/markets',
      tags: ['admin'],
      summary: 'Create a market',
      description:
        '`b` is computed here from `expectedTraders` and the starting balance, and frozen for the life of the market. The house treasury is debited b·ln(n).',
      scope: 'admin',
      request: { body: { content: { 'application/json': { schema: S.CreateMarketRequest } } } },
      ok: { status: 201, schema: S.CreatedMarket, description: 'The new market.' },
      errors: { 404: 'not_found: no listing with `listingSlug`.', 409: 'slug_taken | house_underfunded' },
    }),
  );

  const upsertListing = op({
    method: 'post',
    path: '/listings',
    tags: ['admin'],
    summary: 'Create or replace a listing',
    description:
      'By slug: creates the listing, or replaces every field of the existing one (a field left out is cleared). The venue stores these fields for display and never fetches or interprets them. Link URLs must be http(s).',
    scope: 'admin',
    request: { body: { content: { 'application/json': { schema: S.UpsertListingRequest } } } },
    ok: { status: 201, schema: S.UpsertedListing, description: 'Created.' },
  });
  upsertListing.responses[200] = {
    ...json(S.UpsertedListing, 'Replaced an existing listing.'),
    headers: RATE_LIMIT_HEADERS,
  };
  r.registerPath(upsertListing);

  r.registerPath(
    op({
      method: 'post',
      path: '/markets/{id}/close',
      tags: ['admin'],
      summary: 'Close a market to trading',
      description: 'Idempotent.',
      scope: 'admin',
      request: { params: idParam },
      ok: { status: 200, schema: S.Market, description: 'The market.' },
      errors: { 404: 'not_found' },
    }),
  );

  r.registerPath(
    op({
      method: 'post',
      path: '/markets/{id}/settle',
      tags: ['admin'],
      summary: 'Settle a market',
      description:
        'Pays 1 unit per winning share and 0 otherwise. Idempotent: repeating the same settlement is a no-op returning 200; naming a different winner after settlement is `409 market_already_settled`.',
      scope: 'admin',
      request: { params: idParam, body: { content: { 'application/json': { schema: S.SettleRequest } } } },
      ok: { status: 200, schema: S.Market, description: 'The settled market.' },
      errors: { 404: 'not_found: no such market or outcome.', 409: 'market_already_settled | invalid_market' },
    }),
  );

  return r;
}

let cached: ReturnType<OpenApiGeneratorV31['generateDocument']> | undefined;

export function openApiDocument() {
  cached ??= new OpenApiGeneratorV31(buildRegistry().definitions).generateDocument({
    openapi: '3.1.0',
    info: {
      title: 'acceptodds API',
      version: '1.0.0',
      description:
        'A prediction-market venue priced by LMSR, trading a non-convertible play currency called reputation. ' +
        'Amounts are integer micro-units (1 unit = 1,000,000) sent as decimal strings. ' +
        'Errors are always `{ "error": { "code", "message", "details"? } }` with a stable `code`.',
    },
    servers: [{ url: '/api/v1' }],
    tags: [
      { name: 'markets', description: 'Public market data.' },
      { name: 'listings', description: 'Opaque subjects that group markets.' },
      { name: 'trading', description: 'Quotes and orders.' },
      { name: 'accounts', description: 'Public profiles and the leaderboard.' },
      { name: 'groups', description: 'Leaderboard groups: traders ranked among themselves, joined by invite code.' },
      { name: 'me', description: 'The authenticated account.' },
      { name: 'onboarding', description: 'Signing up: plainly, or by choosing a first bet.' },
      { name: 'admin', description: 'Requires the `admin` scope.' },
    ],
  });
  return cached;
}
