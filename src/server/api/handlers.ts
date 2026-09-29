import { isUniqueViolation } from '@/db/errors';
import { authenticate, requireAuth, requireSession, requireTradingEligibility, type Principal } from '../auth';
import { getPortfolio, startingBalanceMicro } from '../accounts';
import * as engine from '../engine';
import * as events from '../events';
import { listComments, postComment } from '../comments';
import { upsertListing } from '../listings';
import { listTokens, mintToken, revokeToken } from '../tokens';
import {
  accountOrders,
  leaderboard as leaderboardView,
  listListings as listListingsView,
  listMarkets as listMarketsView,
  listingView,
  marketTape,
  marketView,
  priceHistory,
  publicAccount,
  resolveListing,
  resolveMarket,
} from '../views';
import { ApiError } from './errors';
import { parseBody, parseParam, parseQuery, respond, route, toIso, toIsoOrNull } from './http';
import {
  presentFill,
  presentListing,
  presentMarket,
  presentMe,
  presentMyOrder,
  presentPortfolio,
  presentQuote,
  presentTapeEntry,
  presentComments,
  presentToken,
} from './present';
import * as S from './schemas';

/**
 * `/api/v1`, one handler per operation. The files under `app/api/v1/` only
 * re-export these.
 *
 * Handlers read through `views.ts` and write **only** by calling the engine
 * (`quote`, `trade`, `settle`, `closeMarket`, `createMarket`). None of them
 * touches market state directly. (Listings, which are not market state, are
 * written by `listings.ts`; comments by `comments.ts`.) Selling is `POST …/orders` with negative
 * `sharesMicro`; there is no sell endpoint.
 *
 * Every read is logged to `events` with its kind and ids — no payload (§1.4) —
 * after the response is built, and a logging failure never reaches the client.
 */

function accountIdOf(p: Principal | null): string | null {
  return p?.account.id ?? null;
}

// ---------------------------------------------------------------------------
// public
// ---------------------------------------------------------------------------

export const listMarkets = route(async (req) => {
  const principal = await authenticate(req);
  const q = parseQuery(req, S.MarketListQuery);
  const { views, nextCursor } = await listMarketsView(q);
  events.log('market.list', { accountId: accountIdOf(principal) });
  return respond(S.MarketList, { markets: views.map(presentMarket), nextCursor }, { principal });
});

export const getMarket = route(async (req, params) => {
  const principal = await authenticate(req);
  const market = await resolveMarket(parseParam(params.id, S.MarketRef, 'id'));
  const view = await marketView(market);
  events.log('market.read', { accountId: accountIdOf(principal), marketId: market.id });
  return respond(S.Market, presentMarket(view), { principal });
});

export const getHistory = route(async (req, params) => {
  const principal = await authenticate(req);
  const market = await resolveMarket(parseParam(params.id, S.MarketRef, 'id'));
  const q = parseQuery(req, S.PaginationQuery);
  const h = await priceHistory(market, q);
  events.log('market.history.read', { accountId: accountIdOf(principal), marketId: market.id });
  return respond(
    S.PriceHistory,
    {
      marketId: market.id,
      outcomes: h.outcomes.map((o) => ({ id: o.id, label: o.label, ordinal: o.ordinal })),
      points: h.points.map((p) => ({ at: toIso(p.at), prices: p.prices })),
      nextCursor: h.nextCursor,
    },
    { principal },
  );
});

export const getTape = route(async (req, params) => {
  const principal = await authenticate(req);
  const market = await resolveMarket(parseParam(params.id, S.MarketRef, 'id'));
  const q = parseQuery(req, S.PaginationQuery);
  const { rows, nextCursor } = await marketTape(market, q);
  events.log('market.tape.read', { accountId: accountIdOf(principal), marketId: market.id });
  // No identities on the public tape: presentTapeEntry drops account and key.
  return respond(S.Tape, { orders: rows.map(presentTapeEntry), nextCursor }, { principal });
});

export const postQuote = route(async (req, params) => {
  const principal = await authenticate(req);
  const market = await resolveMarket(parseParam(params.id, S.MarketRef, 'id'));
  const body = await parseBody(req, S.QuoteRequest);
  const q = await engine.quote(market.id, body.outcomeId, body.sharesMicro);
  events.log('quote.read', { accountId: accountIdOf(principal), marketId: market.id });
  return respond(S.Quote, presentQuote(q), { principal });
});

export const listListings = route(async (req) => {
  const principal = await authenticate(req);
  const q = parseQuery(req, S.ListingListQuery);
  const { views, nextCursor } = await listListingsView(q);
  events.log('listing.list', { accountId: accountIdOf(principal) });
  return respond(S.ListingList, { listings: views.map(presentListing), nextCursor }, { principal });
});

export const getListing = route(async (req, params) => {
  const principal = await authenticate(req);
  const listing = await resolveListing(parseParam(params.id, S.ListingRef, 'id'));
  const view = await listingView(listing);
  events.log('listing.read', { accountId: accountIdOf(principal) });
  return respond(S.Listing, presentListing(view), { principal });
});

export const getLeaderboard = route(async (req) => {
  const principal = await authenticate(req);
  const q = parseQuery(req, S.PaginationQuery);
  const { rows, nextCursor } = await leaderboardView(q);
  events.log('leaderboard.read', { accountId: accountIdOf(principal) });
  return respond(
    S.Leaderboard,
    {
      basis: 'settled_pnl',
      entries: rows.map((r) => ({
        rank: r.rank,
        handle: r.handle,
        displayName: r.displayName,
        isBot: r.isBot,
        institutionName: r.institutionName,
        settledPnlMicro: r.pnlMicro.toString(),
        settledMarkets: r.markets,
      })),
      nextCursor,
    },
    { principal },
  );
});

export const getAccount = route(async (req, params) => {
  const principal = await authenticate(req);
  const handle = parseParam(params.handle, S.Handle, 'handle');
  const { account, settledPnlMicro, settledMarkets } = await publicAccount(handle);
  events.log('account.read', { accountId: accountIdOf(principal) });
  return respond(
    S.PublicAccount,
    {
      handle: account.handle,
      displayName: account.displayName,
      isBot: account.isBot,
      institutionName: account.institutionName,
      rorId: account.rorId,
      verifiedAt: toIsoOrNull(account.verifiedAt),
      createdAt: toIso(account.createdAt),
      settledRecord: { settledPnlMicro: settledPnlMicro.toString(), settledMarkets },
    },
    { principal },
  );
});

export const getComments = route(async (req, params) => {
  const principal = await authenticate(req);
  const market = await resolveMarket(parseParam(params.id, S.MarketRef, 'id'));
  const q = parseQuery(req, S.PaginationQuery);
  const page = await listComments(market.id, { ...q, viewerAccountId: accountIdOf(principal) });
  events.log('comments.read', { accountId: accountIdOf(principal), marketId: market.id });
  return respond(S.CommentList, presentComments(page), { principal });
});

// ---------------------------------------------------------------------------
// authenticated
// ---------------------------------------------------------------------------

export const postOrder = route(async (req, params) => {
  const principal = await requireAuth(req, 'trade');
  requireTradingEligibility(principal);
  const market = await resolveMarket(parseParam(params.id, S.MarketRef, 'id'));
  const body = await parseBody(req, S.OrderRequest);

  const rawKey = req.headers.get('idempotency-key');
  const idempotencyKey = rawKey === null ? null : parseParam(rawKey, S.IdempotencyKey, 'Idempotency-Key');

  const fill = await engine.trade(
    principal.account.id,
    market.id,
    body.outcomeId,
    body.sharesMicro,
    body.maxCostMicro,
    idempotencyKey,
  );

  /**
   * The engine returns the original fill for a reused key, whatever this
   * request asked for. If this request asked for something else, the client
   * has a key-generation bug, and answering "filled" would tell it an order
   * went through that never did. Refuse instead.
   */
  if (
    fill.replayed &&
    (fill.marketId !== market.id || fill.outcomeId !== body.outcomeId || fill.sharesMicro !== body.sharesMicro)
  ) {
    throw new ApiError(409, 'idempotency_key_reused', 'this Idempotency-Key was already used for a different order', {
      orderId: fill.orderId,
    });
  }

  return respond(S.Fill, presentFill(fill), {
    status: 201,
    principal,
    headers: fill.replayed ? { 'Idempotent-Replayed': 'true' } : {},
  });
});

/**
 * Commenting is a `trade`-scope action by a trading-eligible account: the
 * point of the feed is that every comment comes with a real stake behind it.
 */
export const postMarketComment = route(async (req, params) => {
  const principal = await requireAuth(req, 'trade');
  requireTradingEligibility(principal);
  const market = await resolveMarket(parseParam(params.id, S.MarketRef, 'id'));
  const body = await parseBody(req, S.CommentRequest);
  const created = await postComment({ marketId: market.id, accountId: principal.account.id, body: body.body });
  events.log('comment.posted', { accountId: principal.account.id, marketId: market.id });
  const page = await listComments(market.id, { limit: 50, viewerAccountId: principal.account.id });
  const mine = page.comments.find((c) => c.id === created.id)!;
  return respond(S.Comment, presentComments({ comments: [mine], nextCursor: null }).comments[0], {
    status: 201,
    principal,
  });
});

export const getMe = route(async (req) => {
  const principal = await requireAuth(req, 'read');
  events.log('me.read', { accountId: principal.account.id });
  return respond(S.Me, presentMe(principal), { principal });
});

export const getMyPortfolio = route(async (req) => {
  const principal = await requireAuth(req, 'read');
  const portfolio = await getPortfolio(principal.account.id);
  events.log('portfolio.read', { accountId: principal.account.id });
  return respond(S.Portfolio, presentPortfolio(portfolio), { principal });
});

export const getMyOrders = route(async (req) => {
  const principal = await requireAuth(req, 'read');
  const q = parseQuery(req, S.PaginationQuery);
  const { rows, nextCursor } = await accountOrders(principal.account.id, q);
  events.log('me.orders.read', { accountId: principal.account.id });
  return respond(S.MyOrders, { orders: rows.map(presentMyOrder), nextCursor }, { principal });
});

/**
 * Token management. **Session only, never a token** (§7): a leaked token must
 * not be able to mint its successor or hide its own revocation. Bot tokens,
 * and any `admin` token, are minted by an operator with `npm run token:mint`.
 */
function userIdOf(p: Principal): string {
  if (!p.account.userId) throw new ApiError(403, 'session_required', 'this account has no sign-in');
  return p.account.userId;
}

export const postMyToken = route(async (req) => {
  const principal = await requireSession(req);
  const body = await parseBody(req, S.CreateTokenRequest);
  const { token, record } = await mintToken({ account: principal.account, name: body.name, scopes: body.scopes });
  events.log('token.minted', { accountId: principal.account.id });
  return respond(
    S.CreatedToken,
    { id: record.id, name: record.name, start: record.start, scopes: record.scopes, createdAt: toIso(record.createdAt), token },
    { status: 201, principal },
  );
});

export const getMyTokens = route(async (req) => {
  const principal = await requireSession(req);
  const tokens = await listTokens(userIdOf(principal));
  return respond(S.TokenList, { tokens: tokens.map(presentToken) }, { principal });
});

export const deleteMyToken = route(async (req, params) => {
  const principal = await requireSession(req);
  const id = parseParam(params.id, S.TokenId, 'id');
  if (!(await revokeToken(userIdOf(principal), id))) {
    throw new ApiError(404, 'not_found', `no token ${id}`);
  }
  return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
});

// ---------------------------------------------------------------------------
// admin
// ---------------------------------------------------------------------------

export const postMarket = route(async (req) => {
  const principal = await requireAuth(req, 'admin');
  const body = await parseBody(req, S.CreateMarketRequest);
  const closesAt = new Date(body.closesAt);
  if (closesAt.getTime() <= Date.now()) {
    throw new ApiError(400, 'validation_error', 'closesAt must be in the future');
  }
  if (body.listingRank !== undefined && body.listingSlug === undefined) {
    throw new ApiError(400, 'validation_error', 'listingRank needs a listingSlug');
  }
  // Listings are never deleted, so one that exists now still exists at the insert.
  const listing = body.listingSlug === undefined ? null : await resolveListing(body.listingSlug);

  let created;
  try {
    created = await engine.createMarket({
      slug: body.slug,
      question: body.question,
      description: body.description ?? null,
      kind: body.kind,
      outcomes: body.outcomes,
      closesAt,
      resolutionSource: body.resolutionSource ?? null,
      createdBy: principal.account.id,
      // b is computed from these inside createMarket, once, and frozen (§1.3).
      startingBalanceMicro: startingBalanceMicro(),
      expectedTraders: body.expectedTraders,
      status: 'open',
      listingId: listing?.id ?? null,
      listingRank: body.listingRank ?? 0,
    });
  } catch (err) {
    // The market's slug, or its maker's `market:<slug>` handle, already exists.
    if (isUniqueViolation(err)) {
      throw new ApiError(409, 'slug_taken', `a market with slug "${body.slug}" already exists`);
    }
    throw err;
  }

  const view = await marketView(await resolveMarket(created.marketId));
  return respond(
    S.CreatedMarket,
    { market: presentMarket(view), subsidyMicro: created.subsidyMicro.toString() },
    { status: 201, principal },
  );
});

/**
 * Create or replace a listing by slug. Not market state: written by
 * `listings.ts` in its own transaction. 201 when created, 200 when replaced.
 */
export const postListing = route(async (req) => {
  const principal = await requireAuth(req, 'admin');
  const body = await parseBody(req, S.UpsertListingRequest);
  const { listing, created } = await upsertListing({
    slug: body.slug,
    title: body.title,
    summary: body.summary ?? null,
    authors: body.authors ?? [],
    links: body.links ?? [],
    kind: body.kind ?? null,
  });
  events.log(created ? 'listing.created' : 'listing.updated', { accountId: principal.account.id });
  return respond(
    S.UpsertedListing,
    { listing: presentListing(await listingView(listing)), created },
    { status: created ? 201 : 200, principal },
  );
});

export const postClose = route(async (req, params) => {
  const principal = await requireAuth(req, 'admin');
  const market = await resolveMarket(parseParam(params.id, S.MarketRef, 'id'));
  await engine.closeMarket(market.id);
  const view = await marketView(await resolveMarket(market.id));
  return respond(S.Market, presentMarket(view), { principal });
});

export const postSettle = route(async (req, params) => {
  const principal = await requireAuth(req, 'admin');
  const market = await resolveMarket(parseParam(params.id, S.MarketRef, 'id'));
  const body = await parseBody(req, S.SettleRequest);

  await engine.settle(market.id, body.winningOutcomeId, { evidenceUrl: body.evidenceUrl });

  // `settle` is idempotent and a second run is a no-op — including one that
  // names a different winner. Say so rather than answer 200 to a settlement
  // that did not happen.
  const after = await resolveMarket(market.id);
  if (after.resolvedOutcomeId !== body.winningOutcomeId) {
    throw new ApiError(409, 'market_already_settled', 'market was already settled with a different outcome', {
      resolvedOutcomeId: after.resolvedOutcomeId,
    });
  }
  return respond(S.Market, presentMarket(await marketView(after)), { principal });
});
