import { isUniqueViolation } from '@/db/errors';
import { authenticate, requireAuth, requireSession, requireTradingEligibility, type Principal } from '../auth';
import { getPortfolio, setDisplayName, startingBalanceMicro } from '../accounts';
import * as engine from '../engine';
import * as events from '../events';
import { backComment, withdrawBacking } from '../backings';
import { getComment, listComments, listReplies, postComment } from '../comments';
import { follow, followedListings, setDigestOptIn, unfollow } from '../follows';
import {
  createGroup,
  deleteGroup as deleteGroupRow,
  groupById,
  groupMembersOf,
  groupsOf,
  joinGroup,
  removeMember,
  roleIn,
  rotateInvite,
  updateGroup,
} from '../groups';
import { upsertListing } from '../listings';
import { publicPosition, publicPositionsOf, publish, unpublish } from '../public-positions';
import { listTokens, mintToken, revokeToken } from '../tokens';
import { addAffiliation, listAffiliations, removeAffiliation, verifyAffiliation } from '../affiliations';
import {
  clearPendingBet,
  newBrowserNonce,
  ONBOARDING_BROWSER_COOKIE,
  setFirstPassword,
  startOnboarding,
} from '../onboarding';
import { claimSignUp, sendConfirmation } from '../signup';
import { signInContinueHref } from '@/lib/links';
import { safeReturnTo } from '@/lib/return-to';
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
  presentFollowed,
  presentGroup,
  presentGroupSummary,
  presentListing,
  presentMarket,
  presentAffiliation,
  presentMe,
  presentMyOrder,
  presentPortfolio,
  presentPublicPosition,
  presentQuote,
  presentTapeEntry,
  presentComment,
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
 * written by `listings.ts`; comments by `comments.ts`; comment backings by
 * `backings.ts`, and trimmed by the engine on a sell.) Selling is `POST …/orders` with negative
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
  const q = parseQuery(req, S.LeaderboardQuery);
  const { rows, nextCursor, fieldSize } = await leaderboardView(q);
  events.log('leaderboard.read', { accountId: accountIdOf(principal) });
  return respond(
    S.Leaderboard,
    {
      basis: q.basis,
      fieldSize,
      entries: rows.map((r) => ({
        rank: r.rank,
        handle: r.handle,
        displayName: r.displayName,
        isBot: r.isBot,
        institutions: [...r.institutions],
        settledPnlMicro: r.settledPnlMicro.toString(),
        settledMarkets: r.settledMarkets,
        netWorthMicro: r.netWorthMicro.toString(),
        unrealizedPnlMicro: r.unrealizedPnlMicro.toString(),
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
      institutions: account.institutions,
      rorId: account.rorId,
      verifiedAt: toIsoOrNull(account.verifiedAt),
      createdAt: toIso(account.createdAt),
      settledRecord: { settledPnlMicro: settledPnlMicro.toString(), settledMarkets },
    },
    { principal },
  );
});

/** A trader's public positions (#36), newest first: only those they chose to make public. */
export const getAccountPositions = route(async (req, params) => {
  const principal = await authenticate(req);
  const handle = parseParam(params.handle, S.Handle, 'handle');
  const { account } = await publicAccount(handle);
  const positions = await publicPositionsOf(account.id);
  events.log('account.read', { accountId: accountIdOf(principal) });
  return respond(S.PublicPositionList, { positions: positions.map(presentPublicPosition) }, { principal });
});

/** One public position, by its link id. 404 once its holder has made it private. */
export const getPublicPosition = route(async (req, params) => {
  const principal = await authenticate(req);
  const view = await publicPosition(parseParam(params.id, S.Id, 'id'));
  events.log('position.read', { accountId: accountIdOf(principal), marketId: view.market.id });
  return respond(S.PublicPosition, presentPublicPosition(view), { principal });
});

export const getComments = route(async (req, params) => {
  const principal = await authenticate(req);
  const market = await resolveMarket(parseParam(params.id, S.MarketRef, 'id'));
  const q = parseQuery(req, S.CommentListQuery);
  const page = await listComments(market.id, { ...q, viewerAccountId: accountIdOf(principal) });
  events.log('comments.read', { accountId: accountIdOf(principal), marketId: market.id });
  return respond(S.CommentList, presentComments(page), { principal });
});

/** A page of a comment's direct replies, each with a preview of the replies under it. */
export const getCommentReplies = route(async (req, params) => {
  const principal = await authenticate(req);
  const commentId = parseParam(params.id, S.CommentId, 'id');
  const q = parseQuery(req, S.CommentRepliesQuery);
  const page = await listReplies(commentId, { ...q, viewerAccountId: accountIdOf(principal) });
  events.log('comments.read', { accountId: accountIdOf(principal), marketId: page.marketId });
  return respond(S.CommentReplies, { replies: page.replies.map(presentComment) }, { principal });
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
  const created = await postComment({
    marketId: market.id,
    accountId: principal.account.id,
    body: body.body,
    parentId: body.parentId,
  });
  events.log('comment.posted', { accountId: principal.account.id, marketId: market.id });
  const view = await getComment(created.id, principal.account.id);
  return respond(S.Comment, presentComment(view!), { status: 201, principal });
});

/**
 * Put shares behind a comment. Same gate as posting one. The shares stay in
 * the backer's position; a later sell trims backings newest first.
 */
export const postCommentBacking = route(async (req, params) => {
  const principal = await requireAuth(req, 'trade');
  requireTradingEligibility(principal);
  const commentId = parseParam(params.id, S.CommentId, 'id');
  const body = await parseBody(req, S.CommentBackingRequest);
  const { marketId } = await backComment({
    commentId,
    accountId: principal.account.id,
    outcomeId: body.outcomeId,
    sharesMicro: body.sharesMicro,
  });
  events.log('comment.backed', { accountId: principal.account.id, marketId });
  const view = await getComment(commentId, principal.account.id);
  return respond(S.Comment, presentComment(view!), { status: 201, principal });
});

/** Remove all of the caller's backing from a comment. Idempotent. */
export const deleteCommentBacking = route(async (req, params) => {
  const principal = await requireAuth(req, 'trade');
  requireTradingEligibility(principal);
  const commentId = parseParam(params.id, S.CommentId, 'id');
  const { marketId } = await withdrawBacking({ commentId, accountId: principal.account.id });
  events.log('comment.unbacked', { accountId: principal.account.id, marketId });
  return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
});

export const getMe = route(async (req) => {
  const principal = await requireAuth(req, 'read');
  events.log('me.read', { accountId: principal.account.id });
  return respond(S.Me, presentMe(principal), { principal });
});

/**
 * Your settings. Only `digestOptIn` for now. `read` scope, like the rest of
 * `/me`: it moves no money and places no order.
 */
export const patchMe = route(async (req) => {
  const principal = await requireAuth(req, 'read');
  const body = await parseBody(req, S.UpdateMeRequest);
  let account = principal.account;
  if (body.digestOptIn !== undefined) account = await setDigestOptIn(account.id, body.digestOptIn);
  if (body.displayName !== undefined) account = await setDisplayName(account, body.displayName);
  events.log('me.updated', { accountId: account.id });
  return respond(S.Me, presentMe({ ...principal, account }), { principal });
});

/** Listings you follow, each with its main market's headline price now and 24h ago. */
export const getMyFollows = route(async (req) => {
  const principal = await requireAuth(req, 'read');
  const follows = await followedListings(principal.account.id);
  events.log('follows.read', { accountId: principal.account.id });
  return respond(S.FollowList, { follows: follows.map(presentFollowed) }, { principal });
});

/**
 * Follow or unfollow a listing. Idempotent both ways. `read` scope: a follow is
 * a preference, not a trade, and needs no verified account. Only listings can
 * be followed; a market without one cannot.
 */
async function setFollow(req: Request, id: unknown, on: boolean) {
  const principal = await requireAuth(req, 'read');
  const ref = await resolveListing(parseParam(id, S.ListingRef, 'id'));
  const changed = on ? await follow(principal.account.id, ref.id) : await unfollow(principal.account.id, ref.id);
  if (changed) events.log(on ? 'listing.followed' : 'listing.unfollowed', { accountId: principal.account.id });
  const view = await listingView(ref);
  return respond(S.FollowState, { listingId: ref.id, following: on, followers: view.followers }, { principal });
}

export const putListingFollow = route((req, params) => setFollow(req, params.id, true));
export const deleteListingFollow = route((req, params) => setFollow(req, params.id, false));

// ---------------------------------------------------------------------------
// groups
// ---------------------------------------------------------------------------

/**
 * Leaderboard groups (#25, `server/groups.ts`). Reading one is public — its
 * members are on the public leaderboard anyway — but its invite code goes to
 * members only. Writes need the `read` scope, like follows: a group moves no
 * money and grants nothing.
 */
async function groupResponse(groupId: string, principal: Principal | null, status = 200) {
  const group = await groupById(groupId);
  if (!group) throw new ApiError(404, 'not_found', `no group ${groupId}`);
  const [members, role] = await Promise.all([groupMembersOf(group.id), roleIn(group, accountIdOf(principal))]);
  return respond(S.Group, presentGroup(group, members, role), { status, principal });
}

export const getGroup = route(async (req, params) => {
  const principal = await authenticate(req);
  const id = parseParam(params.id, S.Id, 'id');
  const res = await groupResponse(id, principal);
  events.log('group.read', { accountId: accountIdOf(principal) });
  return res;
});

export const postGroup = route(async (req) => {
  const principal = await requireAuth(req, 'read');
  const body = await parseBody(req, S.CreateGroupRequest);
  const group = await createGroup(principal.account.id, body);
  events.log('group.created', { accountId: principal.account.id });
  return groupResponse(group.id, principal, 201);
});

export const patchGroup = route(async (req, params) => {
  const principal = await requireAuth(req, 'read');
  const id = parseParam(params.id, S.Id, 'id');
  const body = await parseBody(req, S.UpdateGroupRequest);
  await updateGroup(principal.account.id, id, body);
  events.log('group.updated', { accountId: principal.account.id });
  return groupResponse(id, principal);
});

export const deleteGroup = route(async (req, params) => {
  const principal = await requireAuth(req, 'read');
  const id = parseParam(params.id, S.Id, 'id');
  await deleteGroupRow(principal.account.id, id);
  events.log('group.deleted', { accountId: principal.account.id });
  return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
});

/** A new invite code; the old link stops working. */
export const postGroupInvite = route(async (req, params) => {
  const principal = await requireAuth(req, 'read');
  const id = parseParam(params.id, S.Id, 'id');
  await rotateInvite(principal.account.id, id);
  events.log('group.invite_rotated', { accountId: principal.account.id });
  return groupResponse(id, principal);
});

export const postGroupJoin = route(async (req) => {
  const principal = await requireAuth(req, 'read');
  const body = await parseBody(req, S.JoinGroupRequest);
  const group = await joinGroup(principal.account.id, body.inviteCode);
  events.log('group.joined', { accountId: principal.account.id });
  return groupResponse(group.id, principal);
});

/** Leave (your own handle), or, as the admin, remove someone. */
export const deleteGroupMember = route(async (req, params) => {
  const principal = await requireAuth(req, 'read');
  const id = parseParam(params.id, S.Id, 'id');
  const handle = parseParam(params.handle, S.Handle, 'handle');
  if (await removeMember(principal.account.id, id, handle)) {
    events.log('group.member_removed', { accountId: principal.account.id });
  }
  return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
});

export const getMyGroups = route(async (req) => {
  const principal = await requireAuth(req, 'read');
  const groups = await groupsOf(principal.account.id);
  events.log('groups.read', { accountId: principal.account.id });
  return respond(S.GroupList, { groups: groups.map(presentGroupSummary) }, { principal });
});

/**
 * Make one of your positions public, or private again (#36). Idempotent both
 * ways. `trade` scope, not `read`: it names you as the holder, which links
 * you to your comments on that market, so a read-only token must not be
 * able to do it. Only a position you hold can be made public.
 */
async function setPublic(req: Request, outcomeId: unknown, on: boolean) {
  const principal = await requireAuth(req, 'trade');
  const id = parseParam(outcomeId, S.Id, 'outcomeId');
  let publicPositionId: string | null = null;
  if (on) {
    const view = await publish(principal.account.id, id);
    publicPositionId = view.id;
    events.log('position.published', { accountId: principal.account.id, marketId: view.market.id });
  } else if (await unpublish(principal.account.id, id)) {
    events.log('position.unpublished', { accountId: principal.account.id });
  }
  return respond(S.PublicPositionState, { outcomeId: id, publicPositionId }, { principal });
}

export const putMyPositionPublic = route((req, params) => setPublic(req, params.outcomeId, true));
export const deleteMyPositionPublic = route((req, params) => setPublic(req, params.outcomeId, false));

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
    {
      id: record.id,
      name: record.name,
      start: record.start,
      scopes: record.scopes,
      createdAt: toIso(record.createdAt),
      token,
    },
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

/**
 * Affiliations: more institutional addresses, each confirmed by a code mailed
 * to it (`server/affiliations.ts`). **Session only**, like tokens: they decide
 * who may trade, so a leaked token must not be able to change them.
 */
export const getMyAffiliations = route(async (req) => {
  const principal = await requireSession(req);
  const rows = await listAffiliations(principal.account.id);
  return respond(S.AffiliationList, { affiliations: rows.map(presentAffiliation) }, { principal });
});

export const postMyAffiliation = route(async (req) => {
  const principal = await requireSession(req);
  const body = await parseBody(req, S.AddAffiliationRequest);
  const row = await addAffiliation({ account: principal.account, email: body.email });
  events.log('affiliation.requested', { accountId: principal.account.id });
  return respond(S.Affiliation, presentAffiliation(row), { status: 201, principal });
});

export const postMyAffiliationVerify = route(async (req, params) => {
  const principal = await requireSession(req);
  const id = parseParam(params.id, S.AffiliationId, 'id');
  const body = await parseBody(req, S.VerifyAffiliationRequest);
  const row = await verifyAffiliation({ accountId: principal.account.id, id, code: body.code });
  events.log('affiliation.confirmed', { accountId: principal.account.id });
  return respond(S.Affiliation, presentAffiliation(row), { principal });
});

export const deleteMyAffiliation = route(async (req, params) => {
  const principal = await requireSession(req);
  const id = parseParam(params.id, S.AffiliationId, 'id');
  await removeAffiliation({ accountId: principal.account.id, id });
  events.log('affiliation.removed', { accountId: principal.account.id });
  return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
});

// ---------------------------------------------------------------------------
// onboarding
// ---------------------------------------------------------------------------

/**
 * Sign up by betting (`server/onboarding.ts`): no password, no account yet.
 * Answers the same whether or not the address is taken.
 */
export const postOnboarding = route(async (req) => {
  const principal = await authenticate(req);
  const body = await parseBody(req, S.OnboardingRequest);
  const nonce = newBrowserNonce();
  await startOnboarding(body, nonce);
  events.log('onboarding.started', { accountId: null, marketId: body.marketId });
  // Names this browser as the one the bet was chosen in (`choseHere`).
  const cookie =
    `${ONBOARDING_BROWSER_COOKIE}=${nonce}; Path=/; Max-Age=86400; HttpOnly; SameSite=Lax` +
    (process.env.NODE_ENV === 'production' ? '; Secure' : '');
  return respond(S.SignUpStarted, { email: body.email }, { principal, headers: { 'Set-Cookie': cookie } });
});

/**
 * Sign up (`server/signup.ts`): a name and an email, no password; the
 * password is chosen after confirming, at `/signin/continue`. Answers the
 * same whether or not the address is taken.
 */
export const postSignUp = route(async (req) => {
  const principal = await authenticate(req);
  const body = await parseBody(req, S.SignUpRequest);
  const claimed = await claimSignUp(body.email, body.name);
  if (claimed) await sendConfirmation(claimed.email, signInContinueHref(safeReturnTo(body.next)));
  events.log('signup.started', { accountId: null });
  return respond(S.SignUpStarted, { email: body.email }, { principal });
});

/** The first password of an account made by onboarding. Session only. */
export const postMyPassword = route(async (req) => {
  const principal = await requireSession(req);
  const body = await parseBody(req, S.SetPasswordRequest);
  await setFirstPassword(req.headers, body.password);
  events.log('password.set', { accountId: principal.account.id });
  return respond(S.PasswordSet, { ok: true }, { principal });
});

/** Drop the bet chosen during onboarding, once placed or declined. Idempotent. */
export const deleteMyPendingBet = route(async (req) => {
  const principal = await requireSession(req);
  await clearPendingBet(userIdOf(principal));
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
