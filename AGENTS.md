# AGENTS.md — papermarket platform

TypeScript, Next.js 15 (App Router, `src/`), Drizzle + Postgres 16, Vitest +
fast-check. The package was a Python/FastAPI scaffold until 2026-09-23; ignore
anything that says otherwise.

- **Tests:** `npm test` (unit + property, no database). `npm run test:integration`
  needs the dev Postgres up and `TEST_DATABASE_URL` set; it truncates every
  table in that database. `npm run test:all` runs both.
- **Dev database:** `docker compose -f docker-compose.dev.yml up -d`. It
  publishes on `127.0.0.1:55432` — **never** 5432 or 6543, which belong to
  unrelated Supabase containers on the dev host.
- **Migrations:** edit `src/db/schema.ts`, then `npm run db:generate`, then
  `npm run db:migrate`. The generated SQL in `drizzle/` is checked in and is
  the thing that actually runs. Never hand-edit an applied migration.

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
resolution rule. If a change needs to know *what* is being traded, it belongs
in `../research`, which is just another API client.

The venue never goes looking for outcomes either: settlement is an
authenticated admin call made by `../research` when it observes a decision.

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

Each of these came up while implementing §3–§8 and is load-bearing.

- **No naked shorts.** A trader may only sell shares they hold. The plan is
  silent, and it is not cosmetic: an unbacked short takes the proceeds now and
  owes 1 unit per share at settlement, which is exactly how an account reaches
  a negative balance and how the maker ends up unable to pay. Keeping every
  `q_i ≥ 0` is also what keeps the maker's balance `C(q) ≥ b·ln(n) > 0`.
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
  is the transaction *start* time, and a trade that queued on the market row
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
  only at the top level, so a retry racing its original on a *different
  market* (different row locks, so only the unique index can catch it) came
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
  trades carries both. Public endpoints need no scope — but a token that *is*
  sent must be valid (401 otherwise, never a silent downgrade to anonymous),
  and it is counted against its rate-limit bucket and attributed in `events`.
- **Request → account resolution lives only in `server/auth.ts`.** A bearer
  API key or the Better Auth session cookie; both resolve to one `accounts`
  row. Token management (`/me/tokens*`) is session-only (`requireSession`) so
  a leaked token cannot mint its successor or hide its revocation.
- **A reused `Idempotency-Key` for a *different* order is a 409
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
- **The leaderboard is `trade` + `settlement` ledger rows on settled markets.**
  Exact, and immune to self-marking, because a settled market has nothing left
  to mark. House accounts (treasury and makers) are excluded, as they are from
  public profiles.
- **Price history is replayed from the fills,** not sampled: `orders` stores
  only the traded outcome's price, and LMSR prices are a function of the share
  vector, which is the running sum of order shares.
- **Cursors carry Postgres timestamps as text, at microsecond precision.** A
  JS `Date` has milliseconds; two fills in one millisecond would make a page
  boundary skip or repeat a row.
- **Market list filter is `kind`, not `venue`.** There is no venue column and
  adding one would start to answer §12 Q1; `kind` is already the opaque
  grouping string. Drafts are hidden from the list unless asked for.

### Auth (M5)

- **API tokens are Better Auth `apiKey`-plugin keys** (`@better-auth/api-key`),
  not the M4 hand-rolled table, which migration 0002 drops. Format is still
  `pm_live_` + 32 random bytes (a custom key generator). The plugin stores the
  SHA-256 and looks a presented key up *by that hash*, so there is no prefix
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
- **Sessions may `read` and `trade`, never `admin`.** Admin is a token scope,
  minted by an operator with `npm run token:mint`; `POST /me/tokens` only
  accepts `read`/`trade`. M6's admin pages will need a decision here.
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
  Confirming the address *is* the verification. This replaces §8's
  institutional code + ROR lookup, and ORCID sign-in is deferred too; both
  were built and then removed on the owner's call (git history has them).
  The checked-in list is empty, so sign-up is closed until it is filled.
- **The refusal is a 422 `EMAIL_DOMAIN_NOT_ALLOWED`, not a 403.** Better Auth
  answers a 403 from user creation with a fake success (its guard against
  email enumeration), so the person would wait for a mail that never comes.
  The list is not secret, so saying no plainly leaks nothing.
- **Email changes are off** (`user.changeEmail.enabled: false`): a changed
  address would bypass the allowlist.
- **No account, and no reputation, before the email is confirmed.**
  `ensureAccountForUser()` creates the trader row, the `signup` grant and
  `verified_at` + `institution_name` together, from Better Auth's
  `emailVerification.afterEmailVerification`, and again lazily on every
  session request (which `server/auth.ts` only accepts for a confirmed email),
  so a failed callback costs a retry and never leaves a signed-in user
  without a trader. The unique index on `accounts.user_id` decides a race, so
  there is exactly one grant. A domain dropped from the list between sign-up
  and confirmation gets a funded account that is not verified and cannot trade.
- **Better Auth's client IP header is `Cf-Connecting-Ip`**
  (`advanced.ipAddress`), via the exported `CLIENT_IP_HEADER`; its default is
  `X-Forwarded-For`. Its sign-in rate limiter uses in-memory storage, which is
  correct for the single app container in §11 and wrong for more than one.
- **`db/auth-schema.ts` is generated** by `npm run auth:generate` (the
  `auth` CLI, reading `auth.config.ts`). Don't hand-edit it; regenerate after
  changing plugins, then `npm run db:generate`. Its timestamps are `timestamp`
  without time zone because that is what the CLI emits.
- **`drizzle-kit generate` prompts "create or rename?"** whenever a migration
  drops one table and creates another, and refuses without a TTY. Migration
  0002 answered "create" for every Better Auth table. Migration 0003 drops
  0002's `institution_verifications` again (the code flow was removed); it is
  a new migration rather than an edit because 0002 had already been applied.
- **Mail without `RESEND_API_KEY` goes to an in-process outbox** and the
  server log, outside production; in production a missing key throws.
