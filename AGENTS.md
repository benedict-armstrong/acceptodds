# AGENTS.md — papermarket platform

TypeScript, Next.js 16 (App Router, `src/`), Drizzle + Postgres 16, Vitest +
fast-check, on Node 26 (`.node-version`, the Dockerfile). The package was a
Python/FastAPI scaffold until 2026-09-23; ignore anything that says otherwise.

- **Two TypeScripts.** `tsc` is TypeScript 7 (`@typescript/native`), which
  has no compiler API; `typescript` is an alias for `@typescript/typescript6`,
  for what imports the API (typescript-eslint, `next build`'s check). Move
  `typescript` to 7 only once typescript-eslint supports it.
- **ESLint stays on 9** until `eslint-config-next`'s `eslint-plugin-react`
  supports 10; under 10 it crashes on load.

- **Formatting is Prettier** (`.prettierrc.json`: single quotes, 120
  columns). Run `npm run format` after editing and never hand-format;
  `npm run format:check` is the check. Generated files are in
  `.prettierignore`.
- **Tests:** `npm test` (unit + property, no database). `npm run test:integration`
  needs the dev Postgres up and `TEST_DATABASE_URL` set; it truncates every
  table in that database. `npm run test:all` runs both.
- **Dev database:** `docker compose -f docker-compose.dev.yml up -d`. It
  publishes on `127.0.0.1:55432` — **never** 5432 or 6543, which belong to
  unrelated Supabase containers on the dev host.
- **Migrations:** edit `src/db/schema.ts`, then `npm run db:generate`, then
  `npm run db:migrate`. The generated SQL in `drizzle/` is checked in and is
  the thing that actually runs. Never hand-edit an applied migration.
  **Until the first production deploy** there is nothing to migrate, so
  schema changes may instead be squashed: delete `drizzle/`, run
  `npm run db:generate -- --name init`, and recreate the dev and test
  databases. Once production exists, only new migrations.

## Invariants

These came out of a working scaffold and a live research run. They are not
style preferences: **each one has already been got wrong once.** They are
repeated as comments where they bind in the code, and as tests where they can
be tested.

### 1. A mark is not a sale price

A holding's mark is `shares × price`. Closing it pays **less**, because the
cost function moves against the seller on the way out. `engine.quote()` is the
only honest answer to "what is this worth", and the only one a trader can get
without committing.

Wherever both numbers appear — portfolio, leaderboard, API response, UI — they
must be separate, differently named fields. Never show a mark alone next to a
sell button.

### 2. Mid-market net worth is noise

A trader marking their own price impact can show a profit while holding only
losing positions. This actually happened: a net worth of 1351 from a starting
1000, all of it self-inflicted price impact. Net worth is correct at settlement
and meaningless before it. Label it as such in the API, and never rank a
leaderboard on it for an open market.

This is about the **mark**. Net worth at **liquidation value** — cash plus a
real sell-everything quote per holding (`server/valuation.ts`) — is not
self-markable: the exit walks back down the curve the buy walked up, and
rounds in the house's favour, so a trader alone in a market can never show a
gain from their own impact. That one may be shown and ranked on.

### 3. `b` is derived at market creation, then frozen

`b` is sized from the expected field and the starting balance by
`lmsr.liquidityFor(balance, traders, outcomes)` — not a global constant. A `b`
small enough for one trader to pin the price makes the market that trader's
opinion.

**But `b` must never change once trading starts.** Recomputing it mid-market
changes the cost function under existing positions and lets a trader extract
reputation from the transition. It is computed once, at creation, stored on the
market row, and read from there forever. (A `b` that grows with volume is
Othman et al.'s liquidity-sensitive LMSR — a different formula with different
invariants, and out of scope.)

### 4. The event log is never a source of truth

Effects live in `orders`, `positions` and `ledger_entries`. `events` holds only
what would otherwise leave no trace — above all reads: who looked at which
board, and when. Two rules, both absolute:

- **`events` has no payload column. Do not add one.**
- **A logging failure must never raise into the caller.** `events.log()`
  swallows its own errors.

### 5. Two ledgers, and only one is play money

Reputation (`ledger_entries`) and real USD costs (`usd_costs`, model spend and
API bills) live in separate tables with no foreign key between them and no
query that sums across them. They are different kinds of number.

### 6. Money is integer micro-units

`BIGINT` columns, Drizzle `mode: 'bigint'`, `bigint` in TypeScript. 1 unit =
1,000,000 micro. The LMSR cost is irrational by construction, so exactness
inside the maths is unavailable: compute in `number`, round **once**, at the
persistence boundary, via `src/lib/money.ts`. Never float money. Never read a
`numeric` column into a JS number.

### 7. The house is an account

LMSR subsidises a market by at most `b · ln(n)`. That reputation comes from
somewhere: a house account, debited at market creation.

Concretely, every market gets its own **maker account** — a row in `accounts`
with `is_house`, pointed at by `markets.maker_account_id`:

- at creation the house treasury is debited `b · ln(n)` and the maker is
  credited exactly that, so the maker starts holding `C(0)`;
- every trade moves `cost` between the trader and the maker, so the maker's
  balance is always `C(q)`;
- at settlement the maker pays 1 unit per winning share — `q_winner ≤ C(q)` —
  and its residual is swept back to the treasury.

Every movement is therefore a **balanced pair** of ledger rows, and the only
place reputation is ever created is `accounts.createAccount`. The sum of all
balances never moves, and the maker can never go negative, which is
`b · ln(n)` holding in the integers rather than merely in the reals.
`tests/integration/engine.concurrency.test.ts` asserts all of it.

## Scope boundary — load-bearing

**The platform knows nothing about papers.** No corpus, no scraper, no arXiv,
no OpenReview, no model calls. A market is a question, outcomes, an id and a
resolution rule. If a change needs to know _what_ is being traded, it belongs
in `../research`, which is just another API client.

The venue never goes looking for outcomes either: settlement is an
authenticated admin call made by `../research` when it observes a decision.

**Listings are opaque subjects.** `listings` holds a title, a summary, a
`tldr`, names with opaque `authorIds` (one each, or none), `keywords`, a
`primaryArea`, labelled http(s) links and an opaque `kind`, all supplied whole by
`../research` (`POST /listings`, an admin upsert by slug) and never fetched,
checked or interpreted here. A market may belong to one (`listing_id`); its
`listing_rank` orders them, and rank 0 is the listing's **main market**. No
money lives on a listing, and it is written by `server/listings.ts` in its
own transaction, never by the engine. Only the UI calls a listing a paper.

## Where the correctness lives

`src/server/engine.ts` is the **only** module that writes market state.
Everything else reads.

The `trade()` transaction is the whole correctness story of this app:

```
BEGIN
  SELECT * FROM markets WHERE id = $1 FOR UPDATE   -- serializes this market only
  check status = 'open' and now() < closes_at
  read the share vector INSIDE the lock
  cost = costToTrade(...)                          -- recomputed under the lock
  if cost > maxCostMicro -> abort, slippage
  check balance >= cost
  UPDATE outcomes, INSERT orders, INSERT ledger_entries,
  UPDATE accounts.balance_micro, UPSERT positions
COMMIT
```

- `FOR UPDATE` on the market row is what makes concurrent trades correct.
  Without it two traders read the same share vector and both get the pre-trade
  price. Different markets still run in parallel.
- Re-pricing under the lock plus `maxCostMicro` **is** slippage protection. It
  falls out of the locking you already need. Do not build a second mechanism.
- `idempotencyKey` is enforced by a unique index inside the transaction; on
  conflict, return the original fill rather than erroring. Bots retry.
- **Selling is a trade with negative `shares`.** There is no separate code
  path, and adding one would be a bug.
- Settlement pays 1 unit per share of the winning outcome and 0 otherwise, and
  must be idempotent — it will be run twice eventually.

`balance_micro` on `accounts` is a **cache** of `sum(ledger_entries.delta_micro)`.
Write both in the same transaction, always.

## Decisions the plan did not make

Each of these came up while implementing §3–§9 and is load-bearing.

- **No naked shorts.** A trader may only sell shares they hold. The plan is
  silent, and it is not cosmetic: an unbacked short takes the proceeds now and
  owes 1 unit per share at settlement, which is exactly how an account reaches
  a negative balance and how the maker ends up unable to pay. Keeping every
  `q_i ≥ 0` is also what keeps the maker's balance `C(q) ≥ b·ln(n) > 0`.
- **A market may open at a prior** (`openingPrices` on `POST /markets`,
  `createMarket`). The share vector then starts at `lmsr.openingShares`
  (`q0_i = b·ln(p_i/p_min)`: non-negative, the rarest outcome at 0), stored
  both as `outcomes.shares_micro` and, unchanging, as
  `outcomes.opening_shares_micro`. The maker therefore still holds `C(q)`
  and every `q_i ≥ 0`; it starts at `C(q0) = b·ln(1/p_min)` rather than
  `b·ln(n)`, which is what the house is debited. Traders hold none of `q0`,
  so settlement pays only what was traded. **The share vector is the opening
  vector plus the sum of the order shares**: any replay from the fills starts
  from `opening_shares_micro` (`views.priceHistory`, `views.sparklines`,
  `follows.moves`), never from zeros. `b` is unchanged by a prior (§1.3).
- **Costs round in the house's favour**, by `Math.ceil` in `lib/money.ts` —
  which rounds a buy up and a sell's proceeds down with one rule. The
  sub-micro-unit remainder therefore accrues to the venue, an integer round
  trip can never profit, and `b·ln(n)` binds in integers.
- **`events` carries no foreign keys.** An FK on `market_id` makes every log
  insert take a `FOR KEY SHARE` lock on the very market row a trade is holding
  `FOR UPDATE`. That deadlocked the engine against its own log during the
  concurrency test. The log is not a source of truth; it does not get to block
  one. For the same reason the engine logs **after** the commit, never inside
  the transaction.
- **`orders.created_at` defaults to `clock_timestamp()`, not `now()`.** `now()`
  is the transaction _start_ time, and a trade that queued on the market row
  lock started before the trade that beat it to the lock — so a tape ordered by
  `now()` can be in an order the prices were never in.
- **`usd_costs.amount_usd_micro` is `BIGINT` micro-USD**, not a `numeric`
  called `amount_usd`. Real money is an integer for the same reason play money
  is (§1.6).
- **Lock order is market, then trader account.** Always the same order, so
  concurrent trades cannot deadlock. `settle()` takes position and account rows
  ordered by account id for the same reason.
- **Read Postgres error codes through `db/errors.ts`.** Drizzle wraps a failed
  query in a `DrizzleQueryError` whose `cause` holds the SQLSTATE; `err.code`
  on the wrapper is undefined. The engine's idempotency race check once looked
  only at the top level, so a retry racing its original on a _different
  market_ (different row locks, so only the unique index can catch it) came
  back as a 500 instead of the original fill. `isUniqueViolation()` walks the
  cause chain; use it, never `err.code === '23505'`.

### The public API (M4)

- **`src/server/api/schemas.ts` is the contract.** One Zod schema per boundary,
  used to parse requests, to validate every response on the way out
  (`respond()` turns a mismatch into a 500 rather than a surprise in a client),
  and to generate `/api/v1/openapi.json`. An endpoint added under
  `app/api/v1` must be added to `server/api/openapi.ts`; a test fails
  otherwise.
- **Route handlers never write.** They read through `server/views.ts` and
  write only by calling the engine. Route files under `app/api/v1` only
  re-export handlers from `server/api/handlers.ts`.
- **Amounts on the wire are `…Micro` decimal strings.** Money and share counts
  go out as strings so no client parses them into a float (§1.6); requests
  accept a string or a safe JSON integer. The order body is therefore
  `{ outcomeId, sharesMicro, maxCostMicro }`, not the plan's `shares`: one unit
  convention per body, the same as everywhere else.
- **Error codes are a public contract.** `server/api/errors.ts` lists them;
  renaming one breaks bots. Engine codes map onto HTTP statuses there.
- **Scopes do not imply each other.** `read` guards `/me*`, `trade` guards
  `POST …/orders`, `admin` guards create/close/settle. An admin bot that also
  trades carries both. Public endpoints need no scope — but a token that _is_
  sent must be valid (401 otherwise, never a silent downgrade to anonymous),
  and it is counted against its rate-limit bucket and attributed in `events`.
- **Request → account resolution lives only in `server/auth.ts`.** A bearer
  API key or the Better Auth session cookie; both resolve to one `accounts`
  row. Token management (`/me/tokens*`) is session-only (`requireSession`) so
  a leaked token cannot mint its successor or hide its revocation.
- **A reused `Idempotency-Key` for a _different_ order is a 409
  `idempotency_key_reused`.** The engine returns the original fill for any
  reused key; answering "filled" to a request for a different order would tell
  the client an order went through that never did. Same order → the original
  fill, `201`, `replayed: true`, header `Idempotent-Replayed: true`.
- **Settling with a different winner after settlement is a 409
  `market_already_settled`.** `engine.settle` is a silent no-op on a settled
  market; the handler re-reads the market and refuses rather than answer 200 to
  a settlement that did not happen. Repeating the same settlement is a 200.
- **The rate limit is a token bucket per credential** in `rate_limit_buckets`
  (`key = token:<id>`), updated in a short transaction of its own with
  `SELECT … FOR UPDATE`, on Postgres's clock. It has no foreign keys, like
  `events`, so it can never take a lock on a row anything else holds. Every
  token-authenticated request costs one unit, reads included. Anonymous traffic
  is the edge's job (§11) and is not limited in-app.
- **Client IP is read only by `clientIp()`** in `server/api/http.ts`, from
  `Cf-Connecting-Ip`. An ESLint rule rejects the header names anywhere else.
  Nothing is keyed on it yet.
- **The leaderboard has two bases, `?basis=settled_pnl|net_worth`.**
  `settled_pnl` (the API default, so existing bots see no change) is `trade` +
  `settlement` ledger rows on settled markets: exact, and immune to
  self-marking because a settled market has nothing left to mark.
  `net_worth` (the UI default) ranks every non-house trader on liquidation
  value (§1.2's note), valued in one batch by `valuation.valuations()` with
  the engine's own maths and rounding. Both bases build the whole ranked
  field (`views.leaderboardStandings`), then sort and cursor-slice it in JS —
  fine for the field size; snapshot it if that changes. Every entry carries
  both, plus unrealized P&L (holdings' exit value + `trade` rows on
  unsettled markets). Mark-based net worth is never ranked. House accounts
  (treasury and makers) are excluded, as they are from public profiles.
- **Price history is replayed from the fills,** not sampled: `orders` stores
  only the traded outcome's price, and LMSR prices are a function of the share
  vector, which is the running sum of order shares.
- **Cursors carry Postgres timestamps as text, at microsecond precision.** A
  JS `Date` has milliseconds; two fills in one millisecond would make a page
  boundary skip or repeat a row.
- **Market list filter is `kind`, not `venue`.** There is no venue column and
  adding one would start to answer §12 Q1; `kind` is already the opaque
  grouping string. Drafts are hidden from the list unless asked for.
- **Search is Postgres full text, `?q=` on `/listings` and `/markets`.**
  Each listing and market is its own weighted document (listing: title A,
  authors B, summary C; market: question A, description C), built by the
  immutable SQL functions in `drizzle/0003_search_functions.sql` into stored
  generated `search_vector` columns with GIN indexes (`drizzle/0006`). The
  columns are **not in `schema.ts`**, so no row read through Drizzle carries
  one; refer to them only through `views.ts`'s `listingVector`/`marketVector`.
  They were expression indexes until #12: ranking, and rechecking a lossy
  GIN match, rebuilt the vector per matching row — 5 s for a query matching
  30k papers. Changing a document is a new migration replacing the function
  and re-adding the column. A listing's or market's rank is the best of its
  documents, computed in one pass (`group by` over the hits), never by a
  correlated subquery per row. The query is
  `websearch_to_tsquery('english', q)`, OR-ed with a last-word prefix query
  (`lib/search.ts`) unless quotes, `OR` or `-word` are used, and is always a
  bound parameter. A listing matches on its text or any visible market's; a
  market on its text or its listing's. Ranked by `ts_rank_cd` (best of the
  documents), ties by id, paged with a `(rank, id)` cursor that time cursors
  can't be swapped for. Blank `q` is ignored; over 200 chars is a 400.

### Auth (M5)

- **API tokens are Better Auth `apiKey`-plugin keys** (`@better-auth/api-key`),
  not the M4 hand-rolled `api_tokens` table, which is gone. Format is still
  `pm_live_` + 32 random bytes (a custom key generator). The plugin stores the
  SHA-256 and looks a presented key up _by that hash_, so there is no prefix
  lookup or byte comparison to time; that replaces §7's "look up by prefix,
  compare in constant time". Scopes live in the plugin's `permissions` as
  `{ api: [...] }` and are checked by `server/auth.ts`, so a missing scope is a
  403, not the plugin's 401.
- **Bots have a Better Auth user, login-less.** The plugin keys every token on
  a `user`, which contradicts §8's "bots have no user_id". A bot gets a user
  the first time it is issued a token: email `<handle>@bots.papermarket.invalid`
  (reserved TLD, never mailed), no credential, no linked provider — nothing can
  sign in as it. `is_bot` is still what marks a bot.
- **One rate limiter.** The plugin's own per-key limiter is disabled; the M4
  token bucket keys on `apikey:<id>` or `user:<id>` (sessions).
- **Sessions may `read` and `trade`; `admin` only via `ADMIN_EMAILS`.** The
  owner asked for the simplest possible admin model: a signed-in user whose
  email is in the comma-separated `ADMIN_EMAILS` env var also gets `admin`.
  No role column, no admin UI; change the list and restart. `POST /me/tokens`
  still mints only `read`/`trade`; admin tokens come from `npm run token:mint`.
  People make and revoke their own keys under "API keys" on `/profile`
  (`profile/ApiKeys.tsx`), which shows the secret once and never lists
  revoked keys.
- **Cookie-authenticated writes must carry our Origin.** `SameSite=Lax`
  already stops a cross-site POST carrying the cookie; `assertSameOrigin` in
  `server/auth.ts` is the second lock and does not depend on the browser.
  Better Auth's own origin check turns itself **off** when `NODE_ENV=test`;
  it is pinned on (`advanced.disableOriginCheck: false`) so the tests exercise
  what production runs.
- **Trading is gated at the API layer**, by `requireTradingEligibility()`:
  verified or `is_bot`, else `403 not_verified`. Not in `engine.trade()`,
  which takes an account id and trusts its caller about who that is. M6's
  Server Actions must call it too.
- **Institutional verification is an email-domain allowlist, for now.**
  `config/institution-domains.json` (`INSTITUTION_DOMAINS_PATH` overrides)
  maps a domain to an institution name; subdomains match; matching never goes
  below two labels. Sign-up from any other domain is refused in Better Auth's
  `user.create.before` hook, before a user row exists or a mail is sent.
  **An address with a `+tag` is refused everywhere the list is checked**
  (`institutionForEmail`, `lib/email-address.ts`), on the owner's call:
  most servers deliver every tag to one inbox, so they would let one person
  confirm any number of funded accounts. The forms say so before sending.
  Confirming the address _is_ the verification. This replaces §8's
  institutional code + ROR lookup, and ORCID sign-in is deferred too; both
  were built and then removed on the owner's call (git history has them).
  The list is generated, permissively on the owner's call (~55k domains):
  `npm run institutions:build` merges swot, ROR (every type but `company`)
  and Hipo's `edu`/`ac` domains, dropping public suffixes and free mail, plus
  `config/institution-domains.curated.json` (research companies, gaps,
  `exclude`), which wins. Edit the curated file and rebuild; never the
  generated one. Sign-up shows a count, not the names.
- **The refusal is a 422 `EMAIL_DOMAIN_NOT_ALLOWED`, not a 403.** Better Auth
  answers a 403 from user creation with a fake success (its guard against
  email enumeration), so the person would wait for a mail that never comes.
  The list is not secret, so saying no plainly leaks nothing.
- **Email changes are off** (`user.changeEmail.enabled: false`): a changed
  address would bypass the allowlist.
- **No account, and no reputation, before the email is confirmed.**
  `ensureAccountForUser()` creates the trader row, the `signup` grant and
  the primary affiliation (below) together, from Better Auth's
  `emailVerification.afterEmailVerification`, and again lazily on every
  session request (which `server/auth.ts` only accepts for a confirmed email),
  so a failed callback costs a retry and never leaves a signed-in user
  without a trader. The unique index on `accounts.user_id` decides a race, so
  there is exactly one grant. A domain dropped from the list between sign-up
  and confirmation gets a funded account that is not verified and cannot trade
  — until it confirms another address.
- **An account may have several affiliations, each confirmed by its own
  mail** (`affiliations`, written only by `server/affiliations.ts`). The
  sign-up address is the primary one, confirmed with the account and never
  removable. More are added at `/profile` (`/me/affiliations*`,
  session-only like tokens: they decide who may trade): only allowlisted
  domains, re-checked at confirmation; a hashed 6-digit code, an hour,
  five wrong guesses, re-adding rotates it; at most 5 pending; every add
  spends one of 10 mails a day from the account's own bucket
  (`affiliation-mail:<id>`), without which re-adding is unlimited guessing
  at someone else's code. A confirmed
  address belongs to one account (partial unique index; the first to
  confirm wins, `409 affiliation_taken`). Adding an address another
  account has confirmed answers like a free one and mails its owner a note
  with no code, so nobody learns which addresses have accounts. Signing up
  with an address another account has confirmed gives an unverified
  account: one address vouches for one account.
  `accounts.institutions` (distinct names, primary's first) and
  `accounts.verified_at` (earliest confirmation, null when none is left)
  are **caches** of the confirmed rows, rewritten by `syncAccount` in the
  same transaction with the account row locked first, and every change
  bumps the standings cache. `email_verified` on Better Auth's
  `user` is still only the login address.
- **Three pages, one per step: `/welcome`, `/signin`, `/verify-email`.**
  `/welcome` is the only way to sign up (below); `/signin` is for people who
  have an account (password, or "Email me a sign-in link", which also makes
  an account for a new address). **`/verify-email` is the one page after an
  email**: every mail's link lands on it and every code is typed on it, and
  what it shows follows from the session, never from how the person got
  there. Signed in with nothing owed: on to `next`. Signed in and owing a
  name, a password or a waiting bet: `Finish` asks for what is missing,
  places the bet, goes on. No session and `?email=`: `CodeForm`, the 6-digit
  code (confirming signs in and refreshes the page into the case above). No
  session and no address: a link opened twice, so `/signin?error=`.
  Nothing else asks for a name or password after an email; don't add a
  second page that does.
- **Confirming is a link or a 6-digit code, never a dead end** (#15). One
  mail carries both (`sendVerificationEmail` mints the code with the
  email-OTP plugin's server-only `createVerificationOTP`, hashed, rotated on
  every send, an hour like the link). `POST /email-otp/verify-email` runs
  the same `beforeEmailVerification`/`afterEmailVerification` as the link
  and signs in. Every other
  email-OTP route is in `disabledPaths` — sign-in by code would also sign up
  past the password, and password codes are not used — so the only code
  there is is the confirmation one, and the only resend is
  `/send-verification-email`. Signing in unconfirmed with the right
  password (only a user from before sign-up stopped taking passwords has
  one) resends (`sendOnSignIn`) and goes to `/verify-email`. Sign-in and
  the mail's link return to the page the person came from (`?next=`,
  `callbackURL`), only ever a same-site path (`lib/return-to.ts`), by way
  of `/verify-email`. A viewer already signed in never sees `/signin`: they
  go straight to `next`, or to `/profile` when there is none.
- **A broken or used mail link ends on `/signin`, saying why.** Better
  Auth sends a dead confirmation or sign-in link back to its return
  address with `?error=` (`INVALID_TOKEN`, `TOKEN_EXPIRED`, …), and one
  opened a second time back with no error and no session.
  `/verify-email`, the return address, passes either on to
  `/signin?error=` (`LINK_USED` for the second); `/signin` shows
  `lib/link-errors.ts`'s sentence (never the raw code) above the form, and
  skips its first-visit detour to `/welcome` so the message survives a
  fresh browser. While a code is outstanding a banner follows them round
  the site, from this browser's `localStorage` only
  (`lib/pending-confirmation.ts`); it grants nothing. There is still no
  user session, account or reputation before confirmation.
- **Sign-up takes no password and no name** (`POST /onboarding`,
  `server/onboarding.ts`; there is no other sign-up route): an email makes
  a user with no credential and mails the confirmation; the name and
  password come after confirming, at `/verify-email`. Better Auth's
  `/sign-up/email` is in `disabledPaths`. Otherwise anyone could sign up
  with your address and their password and wait for you to confirm it,
  which Better Auth's own confirmation does not undo. As a second lock,
  `afterEmailVerification` drops every password and session the user had
  before the address was proven (`revokeUnprovenAccess`); it runs before
  the confirmation's own session is made. Five sign-up mails per address a
  day (`signup-mail:<email>`).
- **Every auth mail spends a per-address budget**, `auth-mail:<email>`, 10
  a day: confirmations and resets. Over it, nothing is sent and the answer
  is unchanged — a 429 would tell anyone which addresses have accounts,
  since Better Auth only mails an existing one. It is checked before a code
  is minted, so it also caps the fresh 3-guess codes anyone can have made
  for an inbox.
- **A password reset ends every other session**
  (`revokeSessionsOnPasswordReset`).
- **A handle never comes from the email** (`handleFrom`): it is public, and
  a local part is often a full name. No usable name gives `trader-xxxx`;
  the first name an account without one sets (`accounts.setDisplayName`)
  replaces that placeholder, once.
- **Sign-in links** (Better Auth's `magicLink` plugin): `/signin` offers
  "Email me a sign-in link" under the password, for the address typed. The
  allowlist and a per-address budget (`magic-link-mail:<email>`, 5 a day)
  are checked in `sendMagicLink`, before any mail, so an unlisted address
  is a 422 on the page, never a dead link; otherwise the answer is the same
  whether or not the address has an account. A link works once, 15
  minutes. Opened, it signs in — and for an address with no user, makes
  one, confirmed (the link proves the inbox), with no name and no password;
  the trader account follows lazily as for any session. Every link lands on
  `/verify-email` (`authHref(VERIFY_EMAIL, next)`, errors too), which asks
  for what `missingFromUser` says is missing, as above. The name is
  `PATCH /me { displayName }` (`accounts.setDisplayName`: the account's
  display name and Better Auth's `user.name` together, then the standings
  cache is bumped); the handle never changes.
- **Choosing or resetting a password is its own flow**, apart from the
  above: an account with no password (onboarding makes them) that asks for
  a reset (`requestPasswordReset`, from `/set-password`'s "send a new
  link") gets a Better Auth reset link — one use, an hour, to
  `/set-password` (`lib/links.ts` `setPasswordPath`), which sets the
  password with the token (Better Auth creates the missing credential) and
  signs in. `sendResetPassword` words its mail by whether a password
  exists. **The token decides whose password is set**, not the URL: the
  page names that account (`resetTokenEmail`, read without consuming the
  token) and signs in as it; `?email=` is only a hint for resending.
  Someone signed in as a different account is warned, by address, that
  they will be switched to the link's account.
- **Better Auth's client IP header is `Cf-Connecting-Ip`**
  (`advanced.ipAddress`), via the exported `CLIENT_IP_HEADER`; its default is
  `X-Forwarded-For`. Its sign-in rate limiter uses in-memory storage, which is
  correct for the single app container in §11 and wrong for more than one.
- **`db/auth-schema.ts` is generated** by `npm run auth:generate` (the
  `auth` CLI, reading `auth.config.ts`). Don't hand-edit it; regenerate after
  changing plugins, then `npm run db:generate`. Its timestamps are `timestamp`
  without time zone because that is what the CLI emits.
- **`drizzle-kit generate` prompts "create or rename?"** whenever a migration
  drops one table and creates another, and refuses without a TTY. Run it under
  a pseudo-terminal (`script -qfc`) and answer "create", or squash (above).
- **Mail without `RESEND_API_KEY` goes to an in-process outbox** and the
  server log, outside production; in production a missing key throws.

### UI (M6)

- **Style is mockup J, "arXiv digest"**: every page should read like a
  research paper. When designing something new, ask how a paper would set
  it (title block, author line, abstract, numbered sections, booktabs
  tables, captioned figures) and borrow that before inventing a widget.
  Serif for reading, monospace for numbers, one maroon accent. No component library. No invented ids or
  numbers on screen: everything shown comes from the database. Reputation
  is shown as `1,000.00 $rep` (#21): write the unit as `REP` from
  `lib/format.ts`, never the literal. The API is unchanged (`…Micro`).
  Tables are booktabs (`ui.table`/`th`/`td`: heavy top and bottom rules, a
  light one under the header, nothing vertical or between rows; a body
  row highlights on hover) with a
  `<caption className={ui.tableCaption}>` "**Table N.**" above, and what a
  column means in `TableNotes` under it, keyed by an italic letter on the
  heading (`ui.mark`) — never a `title` tooltip; charts get
  a `ui.caption` "**Figure N.**" below. Numbered by hand per page, tables
  and figures separately.
- **Styling is Tailwind v4, utilities in the markup.** The palette and fonts
  are `@theme` tokens in `app/globals.css` (`text-muted`, `border-rule`,
  `font-mono`, …); use a token, not a raw hex, for any colour that has one.
  The 720px breakpoint is the `narrow:` variant. On a phone a table too
  wide for the screen scrolls sideways inside `ui.tableScroll` rather than
  dropping columns; every text field is 16px there (`narrow:text-base`,
  built into `ui.input`), or iOS zooms in when it is focused; charts are
  drawn at their measured width, never a fixed `viewBox` scaled down. Patterns used on more than
  one page (section labels, buttons, box, inputs, table cells) are class
  lists in `components/ui.ts`. Each is a complete look: add utilities for
  properties it doesn't set, never override one it does — Tailwind picks
  the winner by stylesheet order, not class order — so a variant is a
  parameter (`ui.btn({ ghost: true })`). Shared behaviour is a component in
  `components/`: `CopyButton`, `DetailsTable` (label–value rows as a
  booktabs table), the paper's furniture — `TitleBlock` (venue line,
  title, author line, `Abstract`; papers, traders and `/how-it-works` open
  with it), `RunningHead` (the template's line over a rule at the top of a
  paper's page: "Under review as a conference paper at <kind>"), `TableNotes`, `Equation`/`EqRef` (numbered displays, KaTeX)
  and `References`/`Cite` (numbered by hand, like tables) — and `Popover` (Radix, the primitive shadcn
  wraps, in our tokens) for anything that floats over the page, and
  `Modal` (Radix Dialog, likewise) for anything that takes it over, and
  `CodeInput` (shadcn's `InputOTP` over `input-otp`) for a one-time code:
  one real input under the boxes, so paste and autofill work — reuse
  them rather than hand-roll another. Preflight is on: headings, `p` and
  `hr` have no default margins, and `svg` is `display: block`.
- **The UI writes through the public API, not Server Actions.** §9 suggests
  Server Actions; the trade widget and the comment form `fetch` `/api/v1`
  instead, so the UI gets the same validation, Origin check, trading gate,
  idempotency and rate limit as every other client, and §0's "the UI is one
  client of the API" holds literally. Pages are Server Components that _read_
  through `server/views.ts` and render the same JSON shapes the API serves
  (via `server/api/present.ts`), which the client then keeps live.
- **Polling, 3 s, with SWR** (§9). Public reads go out with
  `credentials: 'omit'`, so they are anonymous and don't spend the viewer's
  rate-limit bucket; only portfolio and comments are fetched as the viewer.
  The chart starts from the full server-side history and gains a point each
  time the tape shows a new fill (the board's prices after a fill are the
  exact post-fill vector).
- **Server Components identify the viewer with `viewerFromHeaders()`** in
  `server/auth.ts`: read-only, no rate limit, no Origin check. Anything that
  writes goes through the API.
- **The trade widget sends the quote it showed as `maxCostMicro`**, with a
  fresh `Idempotency-Key` per order (kept across a network-error retry of the
  same order, replaced when the order changes). So the charged cost is the
  displayed cost or better, or the order is refused — checked end to end.
  The form only buys, by **stake**: the viewer enters what to spend in
  `REP`, `lmsr.sharesForCost` turns it into shares on the polled board, and
  the quote for those shares is what is shown ("pays N if …") and sent as
  the bound — the API still takes shares. The viewer's positions are a
  full-width table under the chart (`components/PositionsTable`, also
  `/portfolio`'s, with a paper column: the listing's title, one line, cut
  by `components/PaperName`, as in closed positions): `Bought @` (the average
  price paid, from `Holding.costBasisMicro`: average cost over the fills,
  `lib/cost-basis.ts`), `Payout` (shares, 1 each if it wins) and `Current
value`, the exit quote against the basis as % or `REP` (toggled in the
  header) — never the mark (§1.1), so it is a little negative right after
  a buy. Selling is per row, in a
  `SellModal` (10/50/100% or a custom amount, capped at the holding),
  quoted live and bounded like a buy, so nothing unheld can be offered.
  Both send through `useOrder` (`components/orders.ts`). A row's Sell
  shows only for a market in `sellable` (`views.tradingMarketIds`: open
  and before `closes_at`, the engine's own test).
- **The navbar shows where the viewer stands** (#17, `components/NavWorth`):
  a tiny bell curve of the net-worth field with a line at the viewer
  (`MiniCurve`). Hovering it (tapping, on touch) opens a `Popover` below
  with net worth at liquidation value, cash and lifetime P&L (unrealized
  plus realized), nothing more. No field
  yet: the net worth figure instead. The curve is the shared
  field snapshot (#10 section), never a per-viewer valuation of the field;
  the viewer is placed on it by their own live net worth. Beside it, a `profile` link — on a phone, at the foot
  of that panel instead, and the logo drops its wordmark for a signed-in
  viewer, so the header stays one row. A click pins the panel open; hover only peeks.
  `/profile` opens with `components/TraderHeader`, a paper's title block
  (name as title, `@handle, Institution` as the author line, the email,
  then a one-paragraph abstract of the account), then the share button; the standing, the
  field curve and the P&L live on the leaderboard and portfolio, and it carries none of them. Sign-out is at the bottom. P&L is coloured `text-up`/`text-down` via `ui.pnl`.
- **`/people/<handle>` is a trader's public page**: what
  `GET /accounts/{handle}` and the net-worth leaderboard already publish
  (details, rank, net worth at liquidation value, unrealized and settled
  P&L), plus the positions the trader made public (#36, below), and
  nothing more. **Never other holdings, closed positions or follows**:
  comments show the author's stake, so a public list of someone's
  positions would unmask their comments. It opens with the same
  `TraderHeader`, never passed the email or admin flag, then the same
  Figure 1 with that trader dashed and the viewer shaded, as the
  leaderboard's `?around=` draws them, then its own Table 1 of standing. House accounts 404. Every
  trader's name in a list links there; `/profile` has a button to it.
- **A trader's standing is shareable** from `/people/<handle>` and
  `/profile`: "share" (`components/ShareProfile`) copies the name, the
  rank on the net-worth board and a plain-ASCII bar of the share of the
  field below them (`lib/profile-share.ts`, rounded down like
  "ahead of"), then the `/people/<handle>` link. That page's
  `opengraph-image.tsx` (`og.profileImage`) draws the same rank and the
  field snapshot's curve with them on it, shaded below, from the board's
  own figure. Only what the page already shows; never a mark. Satori lays
  out a fragment as a row, so a card's body is one column box
  (`og.tsx` `BODY`), never `<>`.
- **`/portfolio` lists closed positions** (#22, `accounts.closedPositions`):
  every outcome the viewer traded and now holds none of, one row over all
  its fills, newest first, 50 a page. Read from `orders` alone — positions
  move only by fills, so the shares held into settlement are the fills'
  net, and settlement paid exactly that on the winner. P&L is sells +
  payout − buys, the ledger's own integers; it is not a mark (§1.1).
- **"Venue" is the market's `kind`.** The home page filters on it and opens
  on `DEFAULT_MARKET_KIND` (default `ICLR 2027`) when that venue has markets.
  The platform still knows nothing about venues: it is a string the creating
  client chose. Sorts: acceptance (the default; the `likelihood` sort: the
  main market's **headline** (#11, below), highest first, 1/0 once settled,
  void last), volume, activity (last fill), newest. The
  venue's `closing` sort is not offered. Status and "following" filters sit
  in a `⋯` `Popover` menu, which shows the active one when not the default.
  A signed-in viewer sees a **Following** section above the list: the
  followed subset of that same list (venue, status, sort) the viewer holds
  no shares in, 10 a page on its
  own `?fpage=`, collapsible, the open state in the `home_following_open`
  cookie so the server renders it as left. Then **My positions**, the
  papers the viewer holds shares in (any market of the row), followed or
  not — a position wins over a follow — 10 a page on `?hpage=`, cookie `home_positions_open`. Hidden while
  searching or with `?following=1`. "All papers" below is the rest: nothing
  pinned above is repeated, and the exclusion is in SQL so its pages count
  right.
- **Comments are pseudonymous, OpenReview-style.** Each shows the author's
  alias on the paper ("Reviewer k3xm", "(you)" on the viewer's own), their
  _current_ position in that market and a bot badge — no handle, no account
  id (`server/comments.ts`). The alias (`comment_aliases`, `lib/aliases.ts`)
  is random, made on an account's first comment on a paper, shared by all
  the paper's markets (an unlisted market is its own scope) and unrelated
  to its alias on any other paper; only `server/comments.ts` writes it.
  `@k3xm` mentions one: a comment's `mentions` lists the aliases in its body
  that are commenters on the paper, and the UI highlights only those.
  **A mention mails the reviewer** (`server/mentions.ts`), after the
  commit and never awaited by the request, so a mail failure cannot fail
  the post: to the login address, naming both sides by alias only, never
  to the author, a bot, an unconfirmed address or an account with
  `mention_mail_opt_in` off (`PATCH /me { mentionMailOptIn }`, on
  `/profile`), and at most 10 a day per recipient
  (`mention-mail:<account>`), else `@k3xm` repeated fills an inbox. Posting needs the `trade` scope and a
  trading-eligible account, so every comment has something behind it. The
  stake is read at display time, so it is empty after settlement. `comments`
  has foreign keys (unlike `events`) because it is written in its own tiny
  transaction, never inside a trade. `comment_backings` is the exception
  (below): the engine trims it inside `trade()`.
- **Replies nest** (#31): `comments.parent_id` names the comment answered,
  on the same market, at any depth; the UI indents each level. A
  discussion is never read whole: `GET /markets/{id}/comments` pages
  top-level comments only (20 a page in the UI, "Load more") and adds
  `replies`, a flat preview of the trees under them — the first 3 replies
  to each comment, 3 levels down, one recursive query
  (`comments.previewTree`). `GET /comments/{id}/replies?after=` pages a
  comment's direct replies after the last one loaded (an id, compared in
  SQL at microseconds), each with a 2-level preview; more remain while
  `replyCount` exceeds what is loaded. The relevance sort ranks top-level
  comments only. `total` counts replies too.
- **Comment bodies are Markdown with TeX math**, stored as raw text and
  rendered by `components/Markdown.tsx` (react-markdown + remark-gfm +
  remark-math + rehype-katex; KaTeX's CSS is imported in `app/layout.tsx`).
  No raw HTML (never add `rehype-raw`), links only to absolute http(s) and
  mailto (`lib/markdown.ts`, `rel="nofollow noopener noreferrer ugc"`), and
  images become links, except an https `.gif` on `GIF_HOSTS`
  (`lib/markdown.ts`: giphy, tenor), which renders inline — so a comment can
  make readers fetch only from those CDNs, never an author's own URL.
- **Backing: traders put shares they hold behind other people's comments**
  (`POST`/`DELETE /comments/{id}/backing`, `server/backings.ts`). No
  reputation moves; the shares stay in `positions`. Rules:
  - For each (account, outcome), Σ backing ≤ position — across all comments.
    Over-allocating is `409 insufficient_stake`; your own comment is
    `409 own_comment`. Open markets only (status `open`, before `closes_at`),
    the window in which a position can change. Withdrawing is always allowed.
  - A backing is inserted in a short transaction holding the backer's
    `accounts` row `FOR UPDATE` — the row `trade()` locks second — so a
    backing and a sell on one account serialize. It takes no market lock, so
    there is no lock-order inversion. Its FK checks take only `KEY SHARE` on
    the comment, the (already locked) account and the outcome, which trades
    update without touching its key.
  - **A sell trims backings LIFO**, inside `trade()`'s transaction, after the
    position upsert: newest first (`created_at desc, id desc`, with
    `clock_timestamp()` defaults), whole backings then one partial, until Σ ≤
    the new position (`lib/backing.ts` `lifoTrim`, property-tested). A full
    sell removes them all; buying back restores nothing. This is the engine's
    only write outside market state: it is bound to the position, not the
    market.
  - Settlement zeroes positions but **keeps** backings, as a frozen record
    of who stood behind which argument.
  - **Displayed value is a mark, a relevance weight — never a sale price**
    (§1.1): Σ backed shares × current price, rounded once per outcome with
    `costToMicro` like portfolio marks; after settlement 1 per winning share
    and 0 otherwise; 0 on a void market. Labelled "backing". Backers are
    anonymous: a comment shows a count and the viewer's own share (`yours`),
    and the list carries the viewer's held/allocated per outcome
    (`viewer`, `null` when anonymous).
  - `?sort=relevance` orders the 200 most recent comments by backing value
    (ties newest first) as a single page; `newest` stays keyset-paginated.
- **The home page lists papers, not markets.** One row per listing, read
  from its main market (status, `kind`, closing date, headline price,
  sparkline), with volume summed and activity taken over all its markets;
  a market with no listing is still its own row (`views.browseListings`).
  A listing row opens `/papers/<slug>`: title, authors, links, a collapsible
  abstract, its markets, and the selected one (`?market=`, default the main
  market) rendered by the same `MarketLive` as `/markets/<slug>`, from the
  same loader (`markets/[slug]/load.ts`). `/markets/<slug>` of a listed
  market redirects there.
- **Likelihood colours** are the `accept`, `accept-soft`, `reject`,
  `reject-soft` and `toss-up` tokens, chosen by `lib/likelihood.ts` from a
  market's headline (≥ 65% accept, ≤ 35% reject; the result once settled;
  none when void). Muted on purpose: the maroon accent stays
  the loud colour. Use the helper's class lists, not the tokens ad hoc.
- **List sparklines are the headline, replayed from the fills**
  (`views.sparklines`): `orders.price_after` is only the traded outcome's
  price, which is not enough once the headline depends on the whole vector.
  One query per page; they start at the opening headline (`1 − 1/n`).
- **The home page search box is a plain GET form** (`?q=`, works without
  JS). It carries the current venue and status, so a search stays inside
  them — the result line says where and links "search everything" — and
  sorts by `relevance` (listed only while searching) unless another sort is
  picked; every filter link keeps `q`, "clear" drops it.

### Public positions (#36)

- **A trader may make a position public, one at a time, and nothing else
  about their positions is ever public.** `public_positions` (account +
  outcome, a random `id` that is the link), written only by
  `server/public-positions.ts`, in single statements, never the engine.
  `PUT`/`DELETE /me/positions/{outcomeId}/public`, idempotent, `trade`
  scope (not `read`: it discloses who holds what). Only a position held now
  can be made public (`409 insufficient_shares`).
- **It unmasks the holder's comments on that paper**, since a comment's
  stake ties it to the position and its alias then ties every other. That is accepted, per position, and the Share
  modal (`components/SharePosition`) says so before the switch is made.
  Never make a position public on the trader's behalf, and never list one
  they did not choose.
- **One flag**: public means a link, `/positions/<id>` (page, OG image with
  `@handle holds N <label>` under the title), _and_ a row on
  `/people/<handle>` (`GET /accounts/{handle}/positions`,
  `GET /positions/{id}`). Private again: the row is deleted and the link
  404s; public again is a new link.
- **Read live, from `orders`**, like closed positions: the net of the fills
  is what is held now, or what was held into settlement. Only
  `shared_shares_micro` is stored, so "sold since" shows. Valued by the
  exit quote while trading and the payout once settled, never the mark
  (§1.1); P&L is sales + payout + exit − buys.

### Citations (#38)

- **A listing's bibliography is supplied, never extracted.** `../research`
  sends `references: [{ title, authors?, year?, venue?, url?, slug? }]` with
  `POST /listings`, replaced whole like every other field (left out, it is
  cleared). Stored in `listing_references`, written only by
  `server/listings.ts` in the upsert's transaction.
- **`slug` is matched when read, never by a foreign key**, so a reference
  to a paper listed later links up by itself. "Cited by" is the reverse
  lookup on `cited_slug`'s index. A listing citing itself is left out
  both ways.
- `GET /listings/{id}/citations` gives both, each listed entry with its
  main market; the paper page sets them as back matter, "Cited by" then
  References (`components/Citations`), **as ICLR sets a bibliography**
  (`lib/bibliography.ts`, `Bibliography`): unnumbered, author–year, every
  author ("A, B, and C"), alphabetical by first surname then year, venue
  in italics, hanging indent. A listed entry links to its page with its
  odds in its likelihood colour. Prices, never values. `References`, the
  numbered list, stays for pages that cite in the text (`Cite`).
- The feed (papers sharing citations with what a trader follows or holds)
  is not built yet.

### Related papers

- **A listing's related list is supplied, never computed.** A separate
  similarity service (it embeds papers, maybe on a GPU) sends
  `PUT /listings/{id}/related` (`admin`), `[{ slug, score }]` best first,
  replaced whole. Its own call, apart from `POST /listings`, so the
  service that embeds and the one that lists never overwrite each other.
  Stored in `listing_related`, written only by `server/listings.ts`
  (`setRelated`) in its own transaction. `score` is stored and never
  interpreted; the order is the supplied one.
- **Slugs are matched when read**, as citations' are: an unlisted slug is
  skipped until it is listed. Self and repeated slugs are dropped at write.
  Directional: A naming B says nothing about B.
- `GET /listings/{id}/related` and the paper page's "Related papers"
  (`components/RelatedPapers`, before Citations) show each with its main
  market's odds, in the service's order, not alphabetical. Prices, never
  values.

### The paper map (`/map`)

- **The layout is supplied, never computed**, like related papers. A
  separate service lays the papers out in 2D and names its coarse
  `regions` and fine `clusters`, then sends the whole map with
  `PUT /map` (`admin`), replaced in one transaction (`server/map.ts`,
  `map_points` + `map_topics`). Coordinates are in its own units and
  nothing here interprets them or the groupings. Slugs are matched when
  read; an unlisted one is skipped until it is listed. The research side's
  build and push scripts are in `../scraping/tags/map/`.
- `GET /map` (`views.paperMap`) is the whole map in one response, each
  point with its listing's title and primary area and its main market's
  headline (void: `null`). Prices, never values (§1.1). Public, with
  `Cache-Control: public, max-age=300`.
- The page fetches it anonymously and draws it in WebGL with deck.gl
  (`components/map/MapCanvas`, loaded with `ssr: false`). The display maths
  (scaling, label placement, colours) is `lib/map.ts`. `LIKELIHOOD_RGB`
  copies the likelihood tokens, the same way `TIER_HEX` does, so keep them
  in step. Selecting a paper draws lines to `GET /listings/{id}/related`,
  so the map and the paper page always agree on what is related.
- **The map's search is the home page's**: `GET /map/search?q=` runs
  `views.mapSearch` through the same `browseQuery` as `browseListings`
  (every status unless the query says `status:`) and returns every match's
  slug, best first. The map keeps those lit and fades the rest.
  `components/SearchSyntax` is the help text for both pages.
- **"Redraw" (on by default) hides what a search did not find and lays
  the matches out again, in the browser** —
  display only: never stored or sent, and the supplied map is untouched.
  `lib/map-layout.ts` is a d3-force layout seeded from the supplied
  positions, linked by the similarity service's related lists between
  matches (`GET /map/related`, each listing's best 10, as index pairs) and
  each match's 6 nearest matches on the map. It runs in a Web Worker
  (`lib/map-layout.worker.ts`, one job at a time, a newer search ends the
  last) and is drawn as it settles. The cost is d3's many-body repulsion
  (about 0.7 s per 100 ticks at 4k papers, 4.4 s at 15k), so above
  `MAX_RELAYOUT` (10,000) the matches are shown in place instead. If that cap starts to matter, move the
  simulation to the GPU (cosmos.gl), not into more CPU tuning.

### Crawlers and agents

- **Private pages are one list**, `lib/private-paths.ts`: disallowed in
  `app/robots.ts` _and_ sent `X-Robots-Tag: noindex` by `next.config.ts`
  (robots.txt stops a crawl, not an index entry). A new personal or auth
  page goes there. `robots.ts` also closes `/api/` except `openapi.json`.
- `sitemap.ts`, `llms.txt` and the paper page's JSON-LD
  (`ScholarlyArticle`) read only public data (`server/seo.ts`), and
  `llms.txt` shows no value (§1.1). The sitemap has no `lastModified`: a
  listing has no `updated_at`.

### Views

- **A paper's views are unique viewers per day, summed** (`listings.view_count`,
  `listing_views`, written only by `server/view-counter.ts`). A visitor is
  the signed-in account (session or key), else the client's network: its
  IPv4 address or IPv6 /64 (`lib/ip-network.ts`, from `clientIp()`).
  **Never the user agent**: the client chooses it, so with it in one machine
  was any number of visitors. Anonymous readers behind one NAT count once.
  Stored is an HMAC of the UTC day and that identity under
  `BETTER_AUTH_SECRET`: no address or account id, and the day inside the
  hash means nobody can be followed from one day to the next. One statement
  inserts the row and bumps the cache only when the row was new. Only the
  last two days' rows are kept. Like `events`, no foreign keys and not a
  source of truth. Cloudflare rate-limits the beacon, 10 per 10 s per IP
  (a zone rule in the dashboard, and the Free plan's only rate-limit rule).
- **Counted by a beacon, not on render**: `components/ViewCount` POSTs
  `/api/v1/listings/{id}/view` (`credentials: 'same-origin'`, one unit of a
  signed-in viewer's bucket), so a page
  Cloudflare cached still counts and a crawler without JS does not. Shown on
  the paper page and as `views` on the listing. Unlisted markets have no count.

### Following and the morning digest (#9)

- **Only listings can be followed** (`listing_follows`, pk account + listing,
  written by `server/follows.ts`, one statement, never the engine). A market
  with no listing has no star. No money, no market state; following needs a
  signed-in or token principal with `read` and no verification. `PUT`/`DELETE
/listings/{id}/follow` are idempotent and return `{ following, followers }`;
  `GET /me/follows` gives each followed listing's main-market **headline**
  (#11, below; `negated` says it is `1 − P(outcome)`) now and 24h ago. Listing
  responses carry a `followers` count, never who; `following` is not on the
  public listing shape, since public reads are anonymous.
- **A move is a price, not a value** (§1.1): the price 24h ago is replayed
  exactly from the fills (share vector = Σ order shares up to the cutoff,
  `follows.moves()`), never sampled or estimated.
- **`PATCH /me { digestOptIn }`** (`read` scope, like the rest of `/me`);
  `accounts.digest_opt_in` defaults to true. `mentionMailOptIn` (comment mentions,
  above) is the only other mail setting.
- **The digest is a script, not a scheduler**: `npm run digest:send` from the
  host cron at 07:00 Europe/Zurich (README). Recipients: non-bot, non-house,
  confirmed email, opted in, with a followed main market (`open` or `closed`)
  that moved ≥ `DIGEST_MIN_MOVE_PP` (default 5). **At most once per account
  per `DIGEST_TIMEZONE` day**: the `digest_sends` row is inserted _before_
  the mail, so re-runs and concurrent runs send once; a visible send failure
  deletes the row for a retry, a crash between insert and send loses that
  day's mail rather than doubling it. The unsubscribe link is `/profile`, not
  a signed token. `digest.sent` is logged after the send, no payload.

### The list at venue scale (#12)

A venue is ~30k papers (ICLR's last round). Measured on 30k papers with
~300k fills: a list page is ~25 ms at any sort, a typical search 5–45 ms,
and a query matching every paper ~130 ms. It was 0.4 s a list query
unpaginated, and 5 s for that search.

- **The home list is paged by offset, 50 a page (`?page=`)**, with a total
  (`count(*) over ()`), and so are Following and My positions. Offset, not
  keyset, because every sort but `newest` moves with each fill and a page
  number is what the list shows; the API stays keyset. A page past the end
  serves the last page. The pager is plain links.
- **Sorts never read `orders`.** The engine keeps caches on `markets`,
  written in `trade()` under the market row lock it already holds (so no
  new lock and no drift), like `balance_micro`: `volume_micro` (Σ |cost|),
  `order_count`, `last_trade_at` (the fill's own timestamp, to the µs) and
  `headline` (`marketHeadline`: the headline price, set at creation and
  per fill; 1/0 by the result at settlement). A void market sorts as having
  no headline whatever the cache holds, since nothing sets void yet.
  `MarketView.volumeMicro`/`orderCount` read the same caches.
  `npm run db:seed` moves `last_trade_at` along with the fills it back-dates.
- **`markets.is_main` is the row.** True for a visible standalone market and
  for a listing's main market (lowest rank, ties by age); never a draft. Set
  only by `engine.createMarket`, under a per-listing advisory lock taken
  _before_ the treasury lock (demoting the old main market locks its row,
  and markets lock before accounts); the new market's `created_at` is
  `clock_timestamp()` after that lock, so "ties by age" agrees with the flag.
  A unique partial index allows one per listing. It never changes after
  creation: nothing turns a draft visible or moves a rank. Add a path that
  does, and it must maintain the flag too.
- **A listing's other markets are summed in** through
  `markets_secondary_idx` (`not is_main and status <> 'draft'`), which
  holds only those few, so a row's volume and activity stay the whole
  listing's.

### Four-outcome papers and sharing (#11)

- **A paper has one market by default: `Oral, Spotlight, Poster, Reject`**,
  as its main market (rank 0), created by `../research`. The platform still
  attaches no meaning to the labels, and a listing may still carry more
  markets (the paper page lists them only when there is more than one).
- **Reject also covers a withdrawal** (#19): a paper withdrawn or
  desk-rejected before the decision settles as `Reject`, never void. That is
  `../research`'s call when it settles, and the market's `contract` says so
  to traders (the seed's `DECISION_CONTRACT`); the platform still interprets
  no label.
- **A market carries a `contract`** (`markets.contract`, `POST /markets`):
  Markdown saying in detail how it resolves, edge cases included. Opaque,
  supplied whole by the creating client, shown on the market's page under
  "Contract" and never interpreted here. `description` is the short blurb and
  stays free for anything else.
- **Outcomes are ordered best first, worst last, and the headline is
  `1 − P(last)`** (`lib/headline.ts`) — for a paper, accepted in any form.
  For a binary `[YES, NO]` market that is exactly P(YES), so binary markets
  mean what they always did. Everything that summarises a market in one
  number reads it: likelihood colours, the acceptance sort (the engine's
  `markets.headline` cache, #12; its backfill in `drizzle/0006` is the same
  formula in SQL, exponents clamped because Postgres raises on `exp` over-
  _and_ underflow), sparklines, follows, the digest,
  badges and previews. The UI calls it "accept" on a paper; elsewhere it is
  the first label, or "not <last label>". A market with more outcomes that
  are not ordered will get a meaningless headline: that is the convention's
  price.
- **The outcome bar** draws prices worst on the left in the `tier-1..4`
  tokens (red, amber, green, blue; `TIER_HEX` mirrors them for SVG and
  images — keep the two in step). Two outcomes are red/green. More than four
  get no bar.
- **Share surfaces are reads** (`server/share.ts`), never writes, and show
  prices, never values (§1.1):
  - `/s/<n>` — a paper's `short_id` or an unlisted market's — 307s to its
    page and logs `share.opened` (no payload, no account). Every link we
    hand out is this one (`links.shortPath`). `short_id` comes from one
    sequence, `short_ids`, shared by `listings` and `markets`, so a number
    names one row; all digits is a short id, anything else is still read
    as a slug (old links, and the badge's `/badge/<slug>.svg`).
  - `opengraph-image.tsx` on `/papers/[slug]` and `/markets/[slug]`
    (`server/og.tsx`): the question, `<title> @ <kind>?` (`shareTitleLine`,
    ~120 characters, `@ <kind>?` in the accent), and the outcome bar with
    each outcome's price and label centred on its segment, alternately
    below and above the bar, nudged apart only where a row would still
    collide (`placeLabels`); no band, trader count or link (the card already shows the link).
    Settled: the bar all in the winner's colour, "Decided <label>"; void: an empty bar. Five-minute `Cache-Control`. Its
    font is `assets/fonts/LiberationSerif-Regular.ttf` (OFL), read from disk
    and named in `outputFileTracingIncludes` so standalone output carries it.
    Latin only: no emoji or arrows in the image.
  - `/badge/<slug>.svg` (`lib/badge.ts`): site name, headline, a small bar;
    `?style=compact`, `?bar=0`. Public, five-minute cache, an ETag that
    changes with each fill. An image, not `/api/v1`, so not in OpenAPI.
  - The paper page's **share** button copies a BibTeX `@misc` entry (#33,
    `shareText`: keyed by the slug; `title` is `<title> @ <kind>?`,
    `howpublished` the `\url{}` link, `note` the ten squares while open or
    closed, `year`), never with the viewer's stake (#18). The `⋯` beside it opens
    a popover with only the badge and its Markdown/HTML copy buttons. It
    reads the same SWR key as `MarketLive`, so it adds no polling.
- **Page analytics are Umami** (`components/Analytics`, host-wide
  instance in `~/ops`), on only when `UMAMI_URL` and `UMAMI_WEBSITE_ID` are
  set, counting only `APP_URL`'s host. Every hit's URL and referrer pass
  `lib/analytics.ts`: same-site URLs keep an **allowlist** of query
  parameters (browsing state), never a hash; other sites keep origin and
  path. `/verify-email?email=` is why. A page that puts anything personal in its
  URL stays out by default; add a parameter to the list only if it is not.
  The hook is installed before the script is added, never a bare `<script>`.
  **Product events** go through `track()` in `lib/track.ts` (typed names, and
  data limited to codes and flags: never an email, handle, name, id or amount),
  for Umami funnels: `signup_submitted/refused`, `signin_*`, `code_*`,
  `finish_shown/completed`, `order_placed/refused`, `follow_toggled`,
  `share_copied`. `?step=` and `?error=` are allowlisted for the same funnels.
- **`SITE_NAME`** (default `acceptodds`) is the badge's label and `og:site_name`;
  `APP_URL` (else `BETTER_AUTH_URL`) is the origin in every absolute link.
- **`npm run db:seed`** wipes every table, then gives a venue of invented
  papers under `ICLR 2027` with four-outcome markets, and the admin. A field
  of seed bots, each funded exactly as a signup is, trades them as a crowd, so
  net worths stay around the starting balance. Only a local database without
  `--allow-remote`; a remote one also needs `SEED_ADMIN_PASSWORD`. It back-dates their
  fills so charts have a history — the only place anything but the engine
  touches `orders`, and only timestamps. Never outside a seed.

### Leaderboard, people search and search syntax (#10)

- **A rank is always a rank in the field.** `leaderboardStandings` ranks
  the whole board (after `institution`, which ranks one institution among
  itself); a name search (`?q=`) then only _filters_ it, so every row keeps
  its real rank. `fieldSize` in the API is the denominator. The page's
  `?q=` also takes `institution:x` (`inst:`, `i:`, `-` or `!=` to
  exclude; `lib/trader-query.ts`), a case-insensitive substring of any of
  a trader's institutions — a filter like the name, not `?institution=`'s
  ranking among itself. The API's `?q=` is still only a name. Institution is
  matched exactly against any of a trader's `institutions`, so a trader
  with two affiliations is ranked at both.
- **The page opens compact**: the top 10, a "…", the viewer (or
  `?around=<handle>`, where people results link) with 2 either side, and a
  pager into the whole board (`?page=`, 50 a page). `lib/leaderboard.ts`
  merges windows that touch and never hides a single row behind "…". The
  viewer's row is highlighted, with "Top N% of traders" from the half-way
  line up and "Bottom N%" below it (`standingBand`, never 0%) — from the
  share of the _others_ scoring strictly lower, rounded down, so ties never
  flatter. The people page, its share text and OG image say the same, with no field size.
- **People search is `views.searchPeople`**: substring (ILIKE, LIKE
  characters escaped) or `pg_trgm` word similarity (`<%`), over
  `handle || ' ' || display_name` — written exactly that way, since the
  trigram GIN index in `drizzle/0007` is on that expression and it is not in
  `schema.ts`. Never house accounts. The home page shows up to 5 people
  above the papers when the query is only positive words (`peopleText`).
- **The home search speaks a syntax** (`lib/query.ts`, modelled on
  vvzapi.ch): `key:value` filters (`title author keyword area venue status accept
volume trades`, with aliases), `!= > < >= <=` on numbers, `"quotes"`,
  `-` on a word, filter or group, `OR` and parentheses. A key that is not a
  field is text, so "BERT: pre-training" still searches; a bad value drops
  the term with a visible error. Never throws. Only the home page and the map
  (`GET /map/search`, the same `browseQuery`) speak it: the API's `?q=` on
  `/listings` and `/markets` is still plain websearch.
  - **Words in one AND merge into one websearch string**, so a stop word
    among them is dropped rather than matching nothing, and the last word
    stays a prefix. `-(a b)` is "not both", so a multi-word text node only
    negates by wrapping.
  - **The text every match needs** (`requiredText`: the root's, or a root
    AND's) drives the GIN-indexed hits join and the relevance rank, exactly
    as before. Text under `OR` or `-` is a per-row predicate over the
    stored vectors (`rowMatches`), unranked; relevance then falls back to
    closing date. Text that only excludes means _no_ document in the row
    matches.
  - `venue:` or `status:` in a query makes the page's own filter of that
    kind step aside. `accept` compares the headline cache ×100 (a void
    market fails every comparison, so a negated one includes it); `volume` compares in `numeric` micro-units, never a float.
- **The net-worth leaderboard shows the field's shape** above the table
  (Figure 1, unfiltered `net_worth` only): `components/StandingChart`,
  maths in `lib/distribution.ts` — a Gaussian kernel density of every
  trader's liquidation net worth (never a mark), and for a signed-in
  viewer the part below them shaded and a line at their exact figure from the board; the `?around=` trader, when not
  the viewer, a dashed line, unshaded. Floats there are for plotting only.
- **The ranked field is cached in process** (`views.rankedField`, per
  basis, frozen rows — never mutate them): the leaderboard and its API need
  exact live ranks, so it is invalidated, not aged. `server/standings-cache.ts`
  holds a generation that `engine.trade`, `createMarket`, `settle` and
  `accounts.createAccount` bump **after their commit**; an entry computed
  under an older generation is never served, including one a commit landed
  in the middle of. A 30 s TTL covers writers outside the process (the
  seed). Correct for the single container of §11, like Better Auth's
  limiter. A new write path that moves a balance, a share vector or who is
  a trader must bump it. Not `ledger_entries.created_at` as a version: it
  is not commit order.
- **The curves share one snapshot**, `field_snapshots`
  (`server/field-snapshot.ts`), since the field's shape is the same for
  everyone: every trader's net worth, sorted, as `BIGINT` micro, and its
  density at 120 points, peaking at 1. Recomputed at most every
  `FIELD_SNAPSHOT_MAX_AGE_SECONDS` (300), stale-while-revalidate: an old row
  is served at once and one background refresh starts; only a missing row
  makes a reader wait. An older computation never overwrites a newer row.
  A cache, not a source of truth: no foreign keys, and ranks never read it.

### Groups (#25)

- **A group is a board of its own**: `/leaderboard?group=<id>`, ranked
  among its members exactly as `?institution=` ranks an institution
  (`leaderboardStandings({ group })`, filtering the cached field; the API
  takes `?group=` too, and it combines with `institution`). Either board
  opens like a paper: its name as the title, its members as the author
  line (`components/Authors`, affiliations numbered by first appearance,
  `lib/authors.ts`), the description as the abstract, then Figure 1 of the
  members' net worths (`field-snapshot.shapeOf`, live, uncached) and
  Table 1. The title is "<board> leaderboard" ("Global leaderboard"), and
  the board's name is `components/BoardPicker`, a find box over the boards
  (global, the viewer's institutions and groups, and once typed any
  institution with traders, `views.traderInstitutions`; never a group the
  viewer is not in). "+ New group" sits under the search.
- **Institutions are derived groups**: never a row, always
  `accounts.institutions`, so they cannot drift from the affiliations and
  nobody joins or leaves one by hand. Lab groups were deferred on the
  owner's call.
- **`groups` and `group_members`** are written only by `server/groups.ts`,
  in single statements or short transactions of their own, never by the
  engine; nothing there moves a balance or a share vector, so the standings
  cache needs no bump. The maker is the admin (`admin_account_id`) and the
  first member. The admin renames, rotates the invite code (the old link
  dies, members stay), removes members and deletes; the admin can never
  leave or be removed (`409 group_admin`) — they delete instead. At most
  `MAX_GROUPS_PER_ADMIN` (20) per admin, checked under the admin's account
  row lock (`409 too_many_groups`). Writes need only `read`, like follows.
- **A group is public by id, its invite code is not.** `GET /groups/{id}`
  lists members (their names and institutions are on the public board
  anyway); `inviteCode` only to members. The invite link is
  `/groups/join?code=` (`lib/links.groupInvitePath`): in the query, which
  analytics never records, and joining is the page's POST button, never
  the GET. `group` is deliberately not in `ANALYTICS_PARAMS`.

### Onboarding (`/welcome`)

- **One question at a time**, each in `components/OnboardingCard`, the step
  in `?step=` so back works: which paper (search in `DEFAULT_MARKET_KIND`,
  the most traded open ones before anything is typed), the bet (the market's
  own `TradeBox`), then the email alone, which goes on to `/verify-email` (the name and the
  password come there, after confirming). No comment step: it was dropped to
  keep the way in short. A signed-in viewer's bet goes straight through the
  API and the flow ends at the paper. What the steps collect is client state; a reload
  falls back to the search.
- **A visitor who bets on a market's own page skips the paper and the bet**
  (#39): its trade box hands the choice to `/welcome?step=email` with the
  market, outcome and stake in the URL (`lib/onboarding.ts`
  `welcomeBetHref`), sized against the starting balance. The page re-checks
  it against the market (open, before `closes_at`, its outcome, within the
  starting balance) and otherwise falls back to the full flow. The steps
  is then the email alone; back from it is the market's page. Any market works there, not only a paper's main one.
- **A visitor's bet is stored, never placed, until they confirm**
  (`pending_bets`, one per Better Auth user, `server/onboarding.ts`).
  `POST /onboarding` makes a Better Auth user **with no credential** and
  mails the usual link and code, landing on `/verify-email`. Confirming
  creates the account and grant; there is still no account or reputation
  before it. `Finish` (on `/verify-email`) then places the bet as an
  ordinary order: **the stake is kept, not the share count**, sized on the
  board then and bounded by its quote. Then `DELETE /me/pending-bet`, and
  only then a name (`PATCH /me`) and a password (`POST /me/password`,
  Better Auth's server-only `setPassword`).
  Another onboarding with the same unconfirmed address may replace it, so
  it is placed unasked only in the browser that chose it (below).
- **An unmoved bet is placed without asking** (`pending_bets.seen_order_count`,
  `seenOrderCount` in `POST /onboarding`): the market's `orderCount` on the
  board the bet was chosen from. Prices move only by fills, so while it is
  unchanged the same stake buys the same shares at the price the person
  saw; `Finish` places it on arrival (checking the count again on the fresh
  board, once, guarded against a double mount), then asks for the rest.
  A moved market, or a bet stored before the column (null), is shown at the
  price now to place or skip. The count is client-supplied, so this is also
  gated on the browser: `POST /onboarding` sets an `onboarding_browser`
  cookie (HttpOnly, a random nonce, so the form posts with
  `credentials: 'same-origin'`) and stores its SHA-256 on the bet
  (`browser_hash`). Only where `choseHere` matches is it placed unasked;
  anywhere else — another device, or a bet someone else planted with your
  unconfirmed address — it is shown, saying so.
- **Same answer whether or not the address is taken**: a confirmed
  address is mailed that it already has an account, with a sign-in link
  (the magic link, to `/verify-email`) and a code for the `CodeForm` the
  page is showing (`better-auth.mailExistingAccount`), and the bet is
  stored for that account, to be placed on arrival: unasked only
  where `choseHere`, else shown to place or skip, so a bet planted with
  someone's address is never placed unseen. A new address confirms, then
  `Finish` asks for a name and a password and places it. That code is
  the confirmation one (`createVerificationOTP`, `email-verification`), so
  `/email-otp/verify-email` signs a confirmed user in with it; it is minted
  only here and in confirmation mails, never on a client's say (the magic
  link's `metadata` marker is a per-process secret), and
  `beforeEmailVerification` revokes passwords only for an address not yet
  proven. `/sign-in/email-otp` stays off. Five
  mails per address a day (`signup-mail:<email>`), since the route is
  anonymous.
- **An account's first trade ends on `/first-trade`** (`Fill.firstTrade`):
  the trade as `orders` has it (`views.firstFill`), that market to share
  (its BibTeX entry, as the paper's share button copies; never the stake)
  or a group, then on to its paper. It opens with confetti from the sides
  (`components/Confetti`, none under reduced motion), and "Continue" is a
  ghost button until something is copied or shared. `useOrder` goes there instead of
  `onFilled`. A sign-up's bet comes first in `Finish`, before the name and
  password: placed, the pending bet is dropped and a first trade goes to
  `/first-trade`, whose "Continue" goes back to `/verify-email` while a
  name or password is still owed.
- **`/welcome` comes first, once per browser.** `/signin` redirects to it
  (keeping `?next=`) until the `welcomed` cookie is set, which `/welcome`
  sets when shown; its intro links back to sign-in. The cookie is
  a preference, not a credential, and is not `localStorage` because the
  server has to read it to redirect.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
