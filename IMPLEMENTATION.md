# papermarket platform — implementation plan

*Written 2026-09-23. For an implementing agent. Read all of §0–§2 before writing
any code; the milestones in §3 onward are ordered and each one is verifiable.*

---

## 0. What this is

A prediction market where researchers trade on the fate of conference paper
submissions — acceptance, review score, oral — using a non-convertible play
currency called **reputation**. Prices come from an LMSR cost function, so the
venue always has a quote and never needs a counterparty.

Two classes of trader share one venue: **humans** (web UI, institutional
signup) and **agents** (the `../research` half, trading over the public HTTP
API). Both must be first-class. The public API is not an afterthought bolted
onto the UI — the UI is one client of it.

### Scope boundary, and it is load-bearing

**The platform knows nothing about papers.** A market is a question, a set of
outcomes, an id, and a resolution rule. No corpus, no scraper, no arXiv, no
OpenReview client, no model calls. Anything that needs to know *what* is being
traded belongs in `../research`, which creates markets and reports outcomes
through the same public API every other client uses.

This is what keeps the venue reusable for NeurIPS, ICML, or workshops without
touching the engine.

### This replaces the existing Python scaffold

`exchange/`, `pyproject.toml`, `uv.lock` and `tests/test_smoke.py` are a
FastAPI/SQLite scaffold of the same idea with unimplemented bodies. The stack
decision has moved to TypeScript. **Confirm with the user before deleting
anything** — the scaffold's module docstrings carry the invariants in §1 and
should be read before they are removed. Git history keeps them regardless.

`AGENTS.md` describes the Python layout and will be stale on day one. Rewrite
it as part of Milestone 0, carrying §1 across verbatim in spirit.

---

## 1. Invariants

These came out of a working Python scaffold and a live research run. They are
not style preferences; each one has already been got wrong once. Carry them
into the TypeScript code as comments where they bind, and into tests where they
can be tested.

1. **A mark is not a sale price.** A holding's mark is `shares × price`. Closing
   it pays less, because the cost function moves against the seller on the way
   out. `quote()` is the only honest answer to "what is this worth" and the only
   one a trader can get without committing. Wherever both numbers appear —
   portfolio, leaderboard, API response — they must be separate, differently
   named fields. Never show a mark alone next to a "sell" button.

2. **Mid-market net worth is noise.** A trader marking their own price impact
   can show a profit while holding only losing positions. This happened: a net
   worth of 1351 from 1000, all of it self-inflicted price impact. Net worth is
   correct at settlement and meaningless before it. Label it as such in the API
   and never rank the leaderboard on it for an open market.

3. **Liquidity is derived at market creation, then frozen.** `b` is sized from
   the expected field and the starting balance, not a global constant: a `b`
   small enough for one trader to pin the price makes the market that trader's
   opinion. **But `b` must not change once trading starts.** Recomputing it
   mid-market changes the cost function under existing positions and lets a
   trader extract reputation from the transition. If you ever want `b` to grow
   with volume, that is Othman et al.'s liquidity-sensitive LMSR — a different
   formula with different invariants, and it is out of scope here.

4. **The event log is never a source of truth.** Effects live in `orders`,
   `positions` and `ledger_entries`. `events` holds only what would otherwise
   leave no trace — above all reads: who looked at which board, and when. Two
   rules: never log a payload, and never let a logging failure raise into the
   caller.

5. **Two ledgers, and only one is play money.** Reputation and real USD costs
   (model spend, API bills) are recorded in separate tables with no foreign key
   between them and no query that sums across them.

6. **Money is integer micro-units.** `BIGINT` columns, `bigint` in TypeScript.
   The LMSR cost is irrational by construction, so exactness inside the maths is
   unavailable — compute in `number`, round once at the persistence boundary,
   store integers. Never `float` money, and never `numeric` read into a JS
   number.

7. **The house is an account.** LMSR subsidises the market by at most
   `b × ln(n)`. That reputation comes from somewhere: a house account that the
   market debits at creation. The sum of all balances plus all outstanding
   position value must be conserved, and there is a test for it.

---

## 2. Stack

Self-hosted on this box (`ben-docker-1`), in Docker, behind the **shared
Traefik** in `~/proxy/` and **Cloudflare** in front of that. Read §11 before
writing the compose file — the host has an established pattern and you must
join it, not invent a second one.

| Layer | Choice | Notes |
|---|---|---|
| Runtime | Node 22, TypeScript strict | Matches `x402inference`'s base image |
| Framework | Next.js 15, App Router, `output: 'standalone'` | Standalone output is not optional — see the disk budget in §11 |
| Database | Postgres 16, own container, no published port | Never shared with the Supabase instances already on this host |
| Data access | Drizzle ORM + drizzle-kit, `drizzle-orm/node-postgres` | Plain TCP `pg` driver. Real interactive transactions, so `SELECT … FOR UPDATE` just works |
| Auth | **Better Auth**, in-app, tables in our own Postgres | §8. Self-hosted, no per-MAU billing, no extra container |
| Email | Resend (external) | The one piece not to self-host — deliverability from a single origin IP is a losing battle |
| Validation | Zod, one schema per boundary | |
| UI | Tailwind v4 + shadcn/ui | |
| Charts | Recharts | |
| Live prices | SWR polling, 3s | §9 — SSE is now *available* but still not worth it for v1 |
| Jobs + backups | `ops` sidecar: crond, curls the app, `pg_dump`s the database | §10 |
| Tests | Vitest + fast-check; Postgres service container in CI | |
| Errors | Sentry (self-hosted is overkill; the SaaS free tier is fine) | |
| Edge | Cloudflare → Traefik → app | §11 |

Cut deliberately: Redis, any queue, GraphQL, tRPC, a client state library, a
second reverse proxy, and Kubernetes anything.

**Changed from the hosted draft of this plan:** Neon and Vercel are gone, which
removes the Neon WebSocket-driver gotcha entirely (plain `pg` does transactions
natively) and removes Vercel Cron and Vercel Firewall (replaced by §10 and
§11). Clerk is replaced by Better Auth, because paying per-MAU for a hosted
identity service in front of a fully self-hosted stack makes little sense once
ORCID and the institutional check are things we implement ourselves anyway.

---

## 3. Milestone 0 — skeleton

```sh
npx create-next-app@latest . --ts --app --tailwind --eslint --src-dir --use-npm
npm i drizzle-orm pg zod better-auth swr recharts @sentry/nextjs resend
npm i -D @types/pg
npm i -D drizzle-kit vitest @types/node fast-check tsx
npx shadcn@latest init
```

Layout:

```
src/
  lib/lmsr.ts          pure maths, no imports from anywhere else
  lib/money.ts         micro-unit conversion + rounding, one place
  db/schema.ts         drizzle tables
  db/index.ts          Pool + db handle
  server/engine.ts     quote / trade / settle — the only writer of market state
  server/accounts.ts   accounts, balances, portfolio
  server/events.ts     append-only log
  server/auth.ts       resolve a request to an account (session OR token)
  app/api/v1/...       the public API
  app/(app)/...        the UI
drizzle/               generated migrations, checked in
tests/
```

Also in this milestone:

- `docker-compose.dev.yml` — just Postgres, published on a **non-default host
  port** (say `127.0.0.1:55432`). Port 5432 on this host is already taken by a
  Supabase instance, and 6543 by its pooler. `next dev` runs on the host
  against it; only production runs the app in a container.
- `.env.production.example` with every key and no values, plus a `.env.example`
  for dev. Never commit a filled one.
- A `README.md` saying what the venue is and is not, and a rewritten `AGENTS.md`
  carrying §1.

**Done when:** `npm run build` and `npm run test` both pass on an empty test
suite, and `/healthz` returns `{"status":"ok"}` *after* checking the database.

---

## 4. Milestone 1 — LMSR core, tested before any database exists

`src/lib/lmsr.ts`, pure functions over share vectors. No storage, no accounts,
no imports.

```ts
cost(shares: number[], b: number): number          // b·ln(Σ exp(q_i/b)), shift-invariant
prices(shares: number[], b: number): number[]      // implied probabilities, sums to 1
costToTrade(shares, outcomeIndex, delta, b)        // cost(q') − cost(q)
liquidityFor(balance, traders, outcomes): number   // §1.3 — called once, at creation
```

Compute `cost` shift-invariantly (subtract `max(q_i/b)` before `exp`) or it
overflows on any market that moves decisively.

Property tests with fast-check — these are the real specification:

- `prices()` sums to 1 (within 1e-9) and every element is in (0, 1), for all
  share vectors and all `b > 0`.
- `costToTrade` is **path independent**: buying 10 then 10 costs the same as
  buying 20.
- Buying strictly raises that outcome's price; selling strictly lowers it.
- **A round trip loses money**: buy `n` then immediately sell `n` returns
  strictly less than it cost. This is invariant §1 in executable form.
- Total venue subsidy never exceeds `b · ln(outcomes)`.

**Done when:** those five properties pass at 1000 runs each. No database code
has been written yet, on purpose — if the maths is wrong, everything downstream
is wrong quietly.

---

## 5. Milestone 2 — schema

All money columns `BIGINT`, micro-units, Drizzle `mode: 'bigint'`.

- `accounts` — id, user_id (FK to Better Auth's `user`; nullable, bots have none), handle, display_name,
  orcid, ror_id, institution_name, verified_at, balance_micro, is_bot, is_house,
  created_at
- `api_tokens` — id, account_id, prefix, token_hash, name, created_at,
  last_used_at, revoked_at
- `markets` — id, slug, question, description, kind, status
  (`draft|open|closed|settled|void`), b (double, **frozen at creation**),
  opens_at, closes_at, resolution_source, resolved_outcome_id, settled_at,
  created_by
- `outcomes` — id, market_id, label, ordinal, shares_micro
- `orders` — id, account_id, market_id, outcome_id, shares_micro (signed),
  cost_micro (signed), price_before, price_after, idempotency_key, created_at
- `positions` — (account_id, outcome_id) PK, shares_micro
- `ledger_entries` — id, account_id, delta_micro, reason
  (`signup|trade|settlement|subsidy|adjustment`), order_id, created_at
- `events` — id, kind, account_id, market_id, created_at. **No payload column.**
  Do not add one.
- `usd_costs` — id, source, amount_usd, incurred_at. Separate ledger, §1.5. No
  FK to anything above.

Indexes that matter: `orders(market_id, created_at)` for price history,
`orders(account_id)`, unique `orders(account_id, idempotency_key)` where the key
is not null, `positions(account_id)`.

`balance_micro` on `accounts` is a cache of `sum(ledger_entries.delta_micro)`.
Write both in the same transaction, and add a reconciliation test that asserts
they agree.

Better Auth owns its own tables (`user`, `session`, `account`, `verification`,
`apikey`). Generate them with its CLI and check the migration in alongside ours
— do not hand-write them, and do not put application fields on them; `accounts`
above is ours and references `user` by id.

**Done when:** `drizzle-kit generate` produces a migration, it applies cleanly
to an empty database (`docker compose run --rm app node dist/db/migrate.js`),
and a seed script creates the house account, one market with two outcomes, and
two traders.

---

## 6. Milestone 3 — the engine

`src/server/engine.ts` is the **only** module that writes market state.

```ts
quote(marketId, outcomeId, shares): Promise<Quote>   // never writes
trade(accountId, marketId, outcomeId, shares, maxCostMicro, idempotencyKey): Promise<Fill>
settle(marketId, winningOutcomeId): Promise<void>
```

`Quote` carries `{ outcome, shares, costMicro, priceBefore, priceAfter }` —
priced for the whole requested size, slippage included. A quote is advisory and
must never be trusted by `trade()`.

### The trade transaction

This is the whole correctness story of the app.

```
BEGIN
  SELECT * FROM markets WHERE id = $1 FOR UPDATE      -- serializes this market only
  check status = 'open' and now() < closes_at
  SELECT shares FROM outcomes WHERE market_id = $1     -- inside the lock
  cost = costToTrade(...)                              -- recomputed under the lock
  if cost > maxCostMicro  -> abort, 409 slippage
  check balance >= cost
  UPDATE outcomes SET shares_micro = ...
  INSERT orders, INSERT ledger_entries, UPDATE accounts.balance_micro, UPSERT positions
COMMIT
```

Notes for the implementer:

- `FOR UPDATE` on the market row is what makes concurrent trades correct.
  Without it two traders read the same share vector and both get the pre-trade
  price. Different markets still run in parallel.
- Re-pricing under the lock plus `maxCostMicro` **is** slippage protection — it
  falls out of the locking you already need. Don't build a second mechanism.
- `idempotencyKey` is checked by unique index inside the transaction; on
  conflict, return the original fill rather than erroring. Bots retry.
- Selling is a trade with negative `shares`. There is no separate code path.
- Settlement pays 1 unit per share of the winning outcome, 0 otherwise, writes
  ledger entries, zeroes positions, sets `status = 'settled'`. It must be
  idempotent — re-running settles nothing twice.

**Done when:** an integration test against real Postgres fires 50 concurrent
trades at one market and the invariants hold — conservation of reputation
(§1.7), no negative balances, `balance_micro` equal to the ledger sum, and the
final share vector equal to the sum of order shares.

---

## 7. Milestone 4 — the public API

Versioned under `/api/v1`. This is the contract the research agents trade
through, so treat breaking changes as real. Every response is Zod-validated on
the way out as well as in.

**Public, no auth:**

```
GET  /api/v1/markets                     list, filterable by status/venue
GET  /api/v1/markets/{id}                board: outcomes, prices, volume, b
GET  /api/v1/markets/{id}/history        price series, from orders
GET  /api/v1/markets/{id}/orders         public tape, no account identities
POST /api/v1/markets/{id}/quote          price a hypothetical trade; writes nothing
GET  /api/v1/leaderboard                 settled P&L only, never mid-market net worth (§1.2)
GET  /api/v1/accounts/{handle}           public profile: institution, settled record
```

**Authenticated (session cookie or bearer token, both resolving to one account):**

```
POST /api/v1/markets/{id}/orders         { outcomeId, shares, maxCostMicro }
                                         Idempotency-Key header honoured
GET  /api/v1/me                          account + balance
GET  /api/v1/me/portfolio                holdings with mark AND quoted exit value, separately (§1.1)
GET  /api/v1/me/orders                   own fills
POST /api/v1/me/tokens                   mint an API token (session only, never token-auth)
```

**Admin (separate scope on the token):**

```
POST /api/v1/markets                     create; b computed here and frozen
POST /api/v1/markets/{id}/close
POST /api/v1/markets/{id}/settle         { winningOutcomeId, evidenceUrl }
```

Details that matter for a public API:

- **Tokens:** `pm_live_` + 32 random bytes, shown once, stored as SHA-256. Look
  up by `prefix`, compare hash in constant time. Scopes: `read`, `trade`,
  `admin`.
- **Errors:** one shape everywhere — `{ error: { code, message, details? } }`
  with stable machine-readable `code` strings (`insufficient_balance`,
  `slippage_exceeded`, `market_closed`, `rate_limited`).
- **Rate limits, in two layers.** Anonymous reads are limited at the *edge* —
  a Cloudflare rate-limiting rule, plus a Traefik middleware keyed on
  `Cf-Connecting-Ip` (§11). Per-token limits for authenticated trading are a
  token-bucket row in Postgres updated in the same request — cheaper than
  adding Redis at this scale. Return `X-RateLimit-*` headers and `429` with
  `Retry-After`.
- **Never trust `X-Forwarded-For`.** Every request arrives from a Cloudflare
  proxy IP. The real client is `Cf-Connecting-Ip`, and that header is only
  trustworthy because the origin refuses non-Cloudflare sources (§11). Read it
  through one helper, `clientIp(req)`, and never key anything on the socket
  address.
- **Pagination:** cursor-based (`?cursor=&limit=`), never offset.
- **Publish an OpenAPI 3.1 document** generated from the Zod schemas
  (`zod-to-openapi`) at `/api/v1/openapi.json`, and serve Scalar or Redoc at
  `/docs`. Agents and humans both read it; a hand-maintained doc will rot.
- Log every read to `events` — kind and ids only, no payload (§1.4).

**Done when:** a script authenticating with a minted token can list markets,
quote, trade, and read its portfolio, without touching the UI; and the OpenAPI
document validates.

---

## 8. Milestone 5 — auth and institutional signup

Use **Better Auth**, mounted inside the Next.js app with the Drizzle adapter and
its tables in our own Postgres. Nothing external, nothing per-MAU, one less
container. It gives three things this app specifically needs:

1. **`genericOAuth` plugin → ORCID.** Register a free public-API client at
   developers.orcid.org. Authorize `https://orcid.org/oauth/authorize`, token
   `https://orcid.org/oauth/token`, userinfo `https://orcid.org/oauth/userinfo`,
   scope `/authenticate openid`. ORCID is the real researcher identity — but
   anyone can mint one in a minute, so it is identity, **not** verification.
2. **`apiKey` plugin → the bot tokens §7 needs.** Hashed at rest, prefixed,
   shown once. Use it rather than hand-rolling; map its scopes onto
   `read` / `trade` / `admin`.
3. **Email + password and/or Google** as a fallback for anyone without an ORCID.

**Institutional verification is ours to write**, because no product does it at
this scale — eduGAIN/InCommon means joining a federation as a service provider,
and the "Enterprise SSO" tiers of the hosted vendors are per-organisation SAML
config, which does not survive contact with 2,000 universities. So:

- Send a code to the claimed institutional address (Resend).
- On confirmation, resolve the domain against the [ROR](https://ror.org) data
  dump — **download it into the image or a volume; do not call ROR at runtime**.
  A signup path that depends on a third party being up is a signup path that is
  down.
- Write `ror_id`, `institution_name`, `verified_at` onto `accounts`.

**Gate trading on `verified_at`, not on login.** Anyone signed in may browse and
quote; only a verified account may place an order. That gives a
browse-before-signup funnel and an institution leaderboard for free.

Bot accounts are created by an admin, carry `is_bot`, have no `user_id`, are
exempt from ROR verification, and must be visibly flagged as bots everywhere a
human sees them trade.

Secrets (`BETTER_AUTH_SECRET`, ORCID client id/secret, `RESEND_API_KEY`) come
from `.env.production`, which is **never** committed; ship a
`.env.production.example` with the keys and no values, as `x402inference` does.

**Done when:** a new user can sign up with ORCID, verify an institutional
address, receive `STARTING_BALANCE` via a `signup` ledger entry, and place a
trade — and an unverified account is refused with `403 not_verified`.

---

## 9. Milestone 6 — UI

Pages: market list, market board, portfolio, account/leaderboard, token
management, admin market creation and settlement.

- Server Components render the board; trades go through Server Actions that
  call the same `engine.trade()` as the API.
- **Poll, don't push — but the reason has changed.** SWR with a 3s interval on
  the board. In the hosted draft SSE was ruled out structurally (serverless
  functions can't hold long-lived connections); self-hosted, we *do* have a
  long-running Node server and Postgres `LISTEN/NOTIFY`, so SSE is now merely
  unnecessary rather than impossible. Keep polling for v1; if you do switch,
  note that Cloudflare will buffer a stream unless the response sets
  `Cache-Control: no-cache` and `X-Accel-Buffering: no`, and that the free plan
  drops an idle origin response at ~100s, so the client must reconnect.
- The trade widget must show the quoted cost for the **whole** size, the price
  before and after, and send `maxCostMicro` from what the user was shown.
- Portfolio shows mark and quoted exit value in two labelled columns (§1.1),
  and does not present mid-market net worth as a score (§1.2).

**Done when:** two browsers trading the same market see each other's price
within one poll interval, and the displayed cost equals the charged cost.

---

## 10. Milestone 7 — jobs and backups

One `ops` sidecar in the compose (alpine + `crond` + `curl` + `postgresql-client`)
on the internal network. It does two jobs:

**App jobs** — `curl` the app over the compose network with a shared secret
header, so the routes stay ordinary testable HTTP and never need to be reachable
from outside:

```
*/5 * * * *  curl -fsS -H "X-Cron-Secret: $CRON_SECRET" http://app:3000/api/cron/close
*/5 * * * *  curl -fsS -H "X-Cron-Secret: $CRON_SECRET" http://app:3000/api/cron/snapshot
```

- `close` — close markets past `closes_at`.
- `snapshot` — write a price point per open market so sparse markets still chart.

Both must be idempotent; they will run twice eventually.

**Backups — this is new, and it matters.** The ledger now lives on a disk we own
rather than a managed provider that snapshots for us. A nightly `pg_dump`,
gzipped, to a bind-mounted `~/backups/papermarket/` (the host already uses that
convention), with 14 daily retained and older ones deleted. Given the disk
budget in §11, retention is not optional.

**Restore must be tested once, before launch, and written down in the README.**
An untested backup is not a backup — restore into a scratch database and run the
conservation check from §6 against it.

Settlement is **not** on a cron. It is an authenticated admin API call, made by
`../research` when it observes a decision, carrying `evidenceUrl`. The venue does
not go looking for outcomes — that is the scope boundary in §0.

---

## 11. Deployment on this host

The host has a pattern. Follow it exactly; `~/projects/x402inference/docker-compose.prod.yml`
is the closest working example and is worth reading in full before writing ours.

### What is already there

- **One shared Traefik** (`~/proxy/docker-compose.yml`, v3.3) owns :80 and :443.
  Never run a second proxy, never publish 80/443 from this app.
- Discovery is by **container label**, `exposedbydefault=false`, on the external
  Docker network **`web`**.
- **Cloudflare-only is already enforced globally.** `cfonly@file` is a *default
  middleware on both entrypoints*, so every router on this host inherits it.
  **Do not add a per-router cfonly middleware** — `x402inference` has one for
  historical reasons and it is now redundant duplication.
- **TLS is file-provider Cloudflare Origin CA. There is no ACME and there
  cannot be**: the firewall and `cfonly` admit only Cloudflare, so Let's
  Encrypt's validator can never reach this origin. Routers set `tls: "true"`
  and **no certresolver**.

### One-time setup

1. Decide the domain (open question §12.6) and point it at Cloudflare, proxied,
   SSL mode **Full**.
2. Generate a key + CSR on this host, get a **Cloudflare Origin CA** certificate
   for `papermarket.tld` + `*.papermarket.tld`, drop the pair in
   `~/proxy/certs/` and add a `~/proxy/certs/dynamic/papermarket.yml` SNI entry
   modelled on `presio-ch.yml`. The private key is generated here and never
   leaves the host; only the CSR goes out.
3. `cp .env.production.example .env.production` and fill it.

### Compose shape

```yaml
name: papermarket

services:
  postgres:        # postgres:16, NO published port, healthcheck, pgdata volume
  app:             # build: ., networks [default, web], traefik labels
  ops:             # crond sidecar, networks [default], ~/backups bind mount
```

Non-negotiables, each one learned on this host:

- **Cap the logs on every service.** `json-file` with `max-size: 10m`,
  `max-file: 5`. The default is uncapped and this stack's disk also holds the
  database.
- **Postgres publishes no port.** It is reachable only from `app` and `ops` over
  the compose default network. The ledger is the asset; nothing external touches
  it directly.
- `app` joins **both** `default` and `web`; `postgres` and `ops` join only
  `default`.
- `networks: web: external: true` at the bottom.

Labels:

```yaml
traefik.enable: "true"
traefik.docker.network: "web"
traefik.http.routers.papermarket.entrypoints: "websecure"
traefik.http.routers.papermarket.rule: "Host(`papermarket.tld`)"
traefik.http.routers.papermarket.tls: "true"        # no certresolver, see above
traefik.http.services.papermarket.loadbalancer.server.port: "3000"
traefik.http.middlewares.papermarket-ratelimit.ratelimit.average: "${RATE_LIMIT_AVERAGE:-30}"
traefik.http.middlewares.papermarket-ratelimit.ratelimit.burst: "${RATE_LIMIT_BURST:-60}"
traefik.http.middlewares.papermarket-ratelimit.ratelimit.period: "1s"
traefik.http.middlewares.papermarket-ratelimit.ratelimit.sourcecriterion.requestheadername: "Cf-Connecting-Ip"
traefik.http.middlewares.papermarket-headers.headers.stsseconds: "31536000"
traefik.http.middlewares.papermarket-headers.headers.contenttypenosniff: "true"
traefik.http.middlewares.papermarket-headers.headers.framedeny: "true"
traefik.http.middlewares.papermarket-headers.headers.referrerpolicy: "strict-origin-when-cross-origin"
traefik.http.routers.papermarket.middlewares: "papermarket-ratelimit,papermarket-headers"
```

Rate limiting **must** key on `Cf-Connecting-Ip`. Traefik's default source
criterion is the remote address, and every request here arrives from a
Cloudflare proxy IP — so the default gives one shared bucket for the entire
internet, which is worse than no limit. Keying on the header is sound *only*
because `cfonly` makes the edge unavoidable.

### Cloudflare settings

- SSL mode **Full** (not Full-strict unless you also trust the Origin CA chain).
- A **cache rule that bypasses cache for `/api/*`**. A cached quote or portfolio
  response served to the wrong trader is a correctness bug, not a performance
  one. Belt and braces: send `Cache-Control: no-store` on every `/api/v1`
  response.
- Edge rate-limiting rule on `/api/v1/*` as the outer layer.
- Leave Brotli on; leave Rocket Loader and any HTML minification **off** (they
  break hydration).

### Dockerfile

Multi-stage, modelled on `x402inference`'s:

- `FROM node:22-bookworm-slim` for both stages.
- **`output: 'standalone'` in `next.config.ts`** and copy `.next/standalone`,
  `.next/static`, `public`. This is a ~200 MB image instead of ~1 GB, and the
  disk budget below makes that the difference between fitting and not.
- Copy the Drizzle `.sql` migrations and `meta/_journal.json` explicitly —
  `tsc` does not emit them, and `x402inference` hit exactly this: a deploy image
  whose migrator could not find its own migrations.
- Drop to the image's unprivileged `node` user.
- Also copy the ROR dump (§8) if you vendor it rather than mounting it.

Migrations run as a separate step, never at container start:

```sh
docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build
docker compose -f docker-compose.prod.yml --env-file .env.production run --rm app node dist/db/migrate.js
```

### Host budget — read this before the first build

- **1 vCPU.** A single Xeon E5-2670 core, shared with ~30 running containers.
  `next build` will take minutes, not seconds. Do not add heavy build-time
  codegen, and expect CI-on-host to be the slowest part of the loop. This also
  means the `FOR UPDATE` serialization in §6 costs nothing — there is no
  parallelism to lose.
- **14 GB free, disk at 76%.** Postgres data, images and backups all land on
  `/dev/sda1`. Before the first build, reclaim the **5.9 GB of stale Docker
  build cache**: `docker builder prune`. Then keep standalone output, capped
  logs, and backup retention, or this will bite within months.
- 62 GB RAM, which is the one resource that is not tight.

### Health and monitoring

`/healthz` must check the database, not just return 200 — a container that is up
with a dead connection pool is the failure you actually get. The host already
runs **uptime-kuma**; add a monitor against `https://papermarket.tld/healthz`.

---

## 12. Open questions — ask the user, do not guess

1. **What can people actually bet on?** ICLR 2027 submissions are not public:
   the venue group has `public_submissions: false`, reviews land 2026-11-05 and
   decisions 2026-12-16. If that holds there is no window where a human can read
   a paper and then bet on it. The three ways out reshape the schema more than
   any stack choice: seed boards from **arXiv**; let authors **self-list** their
   own submissions; or run **aggregate** markets ("will the oral rate exceed
   1.5%?"). Resolve this before the Milestone 2 migration.
2. **Starting balance, and whether reputation is ever re-granted.** A venue
   where losers are permanently broke stops being fun; one with free top-ups has
   a meaningless leaderboard.
3. **Who may settle a market,** and whether settlement is appealable.
4. **Is the tape fully public?** Per-account order history public makes for a
   better venue and a worse experience for someone visibly betting against a
   colleague's paper. This is a product call with a privacy edge.
5. **Deleting the Python scaffold** (§0) needs an explicit go-ahead.
6. **Which domain?** Needed before the Cloudflare Origin CA certificate and the
   Traefik router rule in §11 can be written. It must be a zone on the same
   Cloudflare account, proxied, since the origin admits Cloudflare only.
7. **Is this public on the internet from day one,** or Cloudflare Access-gated
   while it is being built? Access in front of everything is one rule and
   costs nothing, and it is much easier to remove than to retrofit.

Keep reputation strictly non-convertible and attach no prize with cash value,
and this stays a game rather than something a regulator has opinions about.
