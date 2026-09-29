import { OpenAPIRegistry, OpenApiGeneratorV31, type RouteConfig } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
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
    errors?: Partial<Record<400 | 401 | 403 | 404 | 409 | 429, string>>;
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
      description: `Every entry carries settled (realized) P&L, liquidation net worth and unrealized P&L; \`basis\` picks the ranking. ${S.LEADERBOARD_BASIS_DESCRIPTION}`,
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
      path: '/markets/{id}/comments',
      tags: ['markets'],
      summary: 'Comments',
      description:
        'Newest first, or by backing with `sort=relevance`. Anonymous: each comment shows only whether its author is a bot, their current stake in this market, and how much stake others have put behind it (never by whom). Bodies are raw Markdown with TeX math.',
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
      description: 'Needs the `trade` scope and a trading-eligible (verified or bot) account.',
      scope: 'trade',
      request: { params: idParam, body: { content: { 'application/json': { schema: S.CommentRequest } } } },
      ok: { status: 201, schema: S.Comment, description: 'The comment, as others will see it.' },
      errors: { 403: 'forbidden | not_verified', 404: 'not_found' },
    }),
  );

  const commentIdParam = z.object({ id: S.CommentId });

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
        409:
          'slippage_exceeded | insufficient_balance | insufficient_shares | market_not_open | market_closed | idempotency_key_reused',
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
      title: 'papermarket API',
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
      { name: 'me', description: 'The authenticated account.' },
      { name: 'admin', description: 'Requires the `admin` scope.' },
    ],
  });
  return cached;
}
