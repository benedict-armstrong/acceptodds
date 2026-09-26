# papermarket — platform

A prediction market venue. Traders buy and sell shares in the outcomes of
questions, priced by an LMSR cost function, using a non-convertible play
currency called **reputation**. Because the price comes from a cost function,
the venue always has a quote and never needs a counterparty.

Two classes of trader share one venue and both are first-class: **humans**
(web UI) and **agents** (the `../research` half, over the public HTTP API).
The UI is one client of the API, not the other way round.

## What this is not

**The platform knows nothing about papers.** A market here is a question, a set
of outcomes, an id and a resolution rule. There is no corpus, no scraper, no
arXiv, no OpenReview client and no model calls anywhere in this package.
Anything that needs to know *what* is being traded lives in `../research`,
which creates markets and reports outcomes through the same public API every
other client uses.

That boundary is what keeps the venue reusable for NeurIPS, ICML or a workshop
without touching the engine. If a change here would need to know what a paper
is, it belongs in `../research`.

Reputation is strictly non-convertible and no prize with cash value is attached
to it. That is deliberate, and it is what keeps this a game.

## Status

| Milestone | State |
|---|---|
| 0 — skeleton | done |
| 1 — LMSR core + property tests | done |
| 2 — schema and migrations | done |
| 3 — engine (quote / trade / settle) | done |
| 4 — public API | not started |
| 5 — auth and institutional signup | not started |
| 6 — UI | not started |
| 7 — jobs and backups | not started |
| deployment | not started (blocked on a domain and credentials) |

There is no Dockerfile and no production compose file yet, on purpose.

## Layout

```
src/
  lib/lmsr.ts        pure maths. imports nothing.
  lib/money.ts       micro-unit conversion and rounding, in one place
  db/schema.ts       drizzle tables
  db/index.ts        Pool + db handle
  db/migrate.ts      migration runner
  db/seed.ts         house account, one market, two traders
  server/engine.ts   quote / trade / settle — the only writer of market state
  server/accounts.ts accounts, balances, portfolio
  server/events.ts   append-only log of things that leave no other trace
drizzle/             generated migrations, checked in
tests/unit/          no database, fast, property-based
tests/integration/   real Postgres
```

## Running it

Start the dev database (published on `127.0.0.1:55432`, because 5432 and 6543
on the dev host are taken by unrelated Supabase containers):

```sh
docker compose -f docker-compose.dev.yml up -d
cp .env.example .env
```

Create the test database once:

```sh
docker compose -f docker-compose.dev.yml exec postgres \
  psql -U papermarket -d papermarket -c 'CREATE DATABASE papermarket_test'
```

Then:

```sh
npm run db:migrate          # apply migrations to $DATABASE_URL
npm run db:seed             # house account, one market, two traders
npm run dev                 # http://localhost:3000, /healthz checks the database
```

## Tests

```sh
npm test                 # unit + property tests, no database needed
npm run test:integration # engine tests against real Postgres ($TEST_DATABASE_URL)
npm run test:all
```

`npm test` includes the five LMSR properties from the plan, at 1000 runs each.
They are the real specification of the maths; if you change `src/lib/lmsr.ts`,
they are what says whether you were right.

`npm run test:integration` includes the concurrency test: 50 concurrent trades
against one market, asserting conservation of reputation, no negative balances,
`balance_micro` equal to the ledger sum, and the final share vector equal to
the sum of order shares. It **truncates every table** in `$TEST_DATABASE_URL`,
so never point that at a database you care about.

## Money

Every monetary amount is an integer number of **micro-units** in a `BIGINT`
column and a `bigint` in TypeScript. 1 unit of reputation = 1,000,000 micro.
The LMSR cost is irrational by construction, so the maths happens in `number`
and is rounded exactly once, at the persistence boundary, by
`src/lib/money.ts`. Money is never a float and never a `numeric` read into a
JS number.

## Reading order for a newcomer

1. `AGENTS.md` — the invariants. Each one has already been got wrong once.
2. `src/lib/lmsr.ts` and `tests/unit/lmsr.test.ts`.
3. `src/server/engine.ts`, specifically `trade()` and the comment above the
   transaction. That transaction is the whole correctness story of this app.
