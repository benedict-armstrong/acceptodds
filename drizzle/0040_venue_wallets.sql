-- One wallet per account per venue (`markets.kind`). Hand-written around the
-- generated statements: existing balances are split into wallets by replaying
-- the ledger, so this runs before `wallet_id` is made NOT NULL and before
-- `accounts.balance_micro` is dropped.
CREATE TABLE "wallets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"kind" text,
	"balance_micro" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "wallets_account_kind_key" ON "wallets" USING btree ("account_id","kind") WHERE kind is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "wallets_account_venueless_key" ON "wallets" USING btree ("account_id") WHERE kind is null;--> statement-breakpoint
CREATE INDEX "wallets_kind_idx" ON "wallets" USING btree ("kind");--> statement-breakpoint
-- The field snapshot is a cache: drop it and key it by venue too.
DELETE FROM "field_snapshots";--> statement-breakpoint
ALTER TABLE "field_snapshots" DROP CONSTRAINT "field_snapshots_pkey";--> statement-breakpoint
ALTER TABLE "field_snapshots" ADD COLUMN "kind" text NOT NULL;--> statement-breakpoint
ALTER TABLE "field_snapshots" ADD CONSTRAINT "field_snapshots_basis_kind_pk" PRIMARY KEY("basis","kind");--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD COLUMN "wallet_id" uuid;--> statement-breakpoint
-- Each trader's home venue takes the rows that name no market (the signup
-- grant, adjustments): the venue of their first order, or the default venue
-- for one who never traded.
CREATE TEMP TABLE "wallet_home" AS
SELECT a.id AS account_id,
       coalesce(
         (SELECT m.kind FROM orders o JOIN markets m ON m.id = o.market_id
           WHERE o.account_id = a.id ORDER BY o.created_at, o.id LIMIT 1),
         'ICLR 2027'
       ) AS kind
  FROM accounts a
 WHERE NOT a.is_house;--> statement-breakpoint
-- The treasury: one venue-less wallet.
INSERT INTO wallets (account_id, kind, created_at)
SELECT a.id, NULL, a.created_at FROM accounts a WHERE a.is_house AND a.handle = 'house';--> statement-breakpoint
-- Makers: one wallet, their market's venue.
INSERT INTO wallets (account_id, kind, created_at)
SELECT m.maker_account_id, m.kind, m.created_at FROM markets m;--> statement-breakpoint
-- Any other house account (a maker whose market was deleted): venue-less.
INSERT INTO wallets (account_id, kind, created_at)
SELECT a.id, NULL, a.created_at FROM accounts a
 WHERE a.is_house AND NOT EXISTS (SELECT 1 FROM wallets w WHERE w.account_id = a.id);--> statement-breakpoint
-- Traders: the home venue, and every venue a ledger row of theirs names.
INSERT INTO wallets (account_id, kind, created_at)
SELECT DISTINCT ON (w.account_id, w.kind) w.account_id, w.kind, a.created_at
  FROM (
    SELECT account_id, kind FROM wallet_home
    UNION
    SELECT le.account_id, m.kind
      FROM ledger_entries le
      JOIN markets m ON m.id = le.market_id
      JOIN accounts a ON a.id = le.account_id AND NOT a.is_house
  ) w
  JOIN accounts a ON a.id = w.account_id;--> statement-breakpoint
-- House rows go to the account's one wallet.
UPDATE ledger_entries le SET wallet_id = w.id
  FROM wallets w JOIN accounts a ON a.id = w.account_id AND a.is_house
 WHERE w.account_id = le.account_id;--> statement-breakpoint
-- A trader's row on a market goes to that market's venue.
UPDATE ledger_entries le SET wallet_id = w.id
  FROM markets m, wallets w
 WHERE le.wallet_id IS NULL AND m.id = le.market_id
   AND w.account_id = le.account_id AND w.kind = m.kind;--> statement-breakpoint
-- Every other row (no market) goes to the home venue.
UPDATE ledger_entries le SET wallet_id = w.id
  FROM wallet_home h, wallets w
 WHERE le.wallet_id IS NULL AND h.account_id = le.account_id
   AND w.account_id = h.account_id AND w.kind = h.kind;--> statement-breakpoint
-- Every venue but the home one gets its own starting grant, the same as the
-- account's original one: from now on a trader's first trade in a venue
-- opens its wallet with the grant. Recorded first, to check against below.
CREATE TEMP TABLE "wallet_added" AS
SELECT w.account_id, w.id AS wallet_id,
       coalesce((SELECT sum(s.delta_micro) FROM ledger_entries s
                  WHERE s.account_id = w.account_id AND s.reason = 'signup'), 1000000000)::bigint AS delta_micro,
       'signup'::ledger_reason AS reason
  FROM wallets w
  JOIN wallet_home h ON h.account_id = w.account_id AND h.kind IS DISTINCT FROM w.kind;--> statement-breakpoint
-- A venue funded from another's winnings would start below zero: top it up.
INSERT INTO wallet_added (account_id, wallet_id, delta_micro, reason)
SELECT w.account_id, w.id,
       -(coalesce((SELECT sum(le.delta_micro) FROM ledger_entries le WHERE le.wallet_id = w.id), 0)
         + coalesce((SELECT sum(x.delta_micro) FROM wallet_added x WHERE x.wallet_id = w.id), 0))::bigint,
       'adjustment'
  FROM wallets w
  JOIN accounts a ON a.id = w.account_id AND NOT a.is_house
 WHERE coalesce((SELECT sum(le.delta_micro) FROM ledger_entries le WHERE le.wallet_id = w.id), 0)
       + coalesce((SELECT sum(x.delta_micro) FROM wallet_added x WHERE x.wallet_id = w.id), 0) < 0;--> statement-breakpoint
INSERT INTO ledger_entries (account_id, wallet_id, delta_micro, reason)
SELECT account_id, wallet_id, delta_micro, reason FROM wallet_added;--> statement-breakpoint
UPDATE wallets w SET balance_micro = coalesce((SELECT sum(le.delta_micro) FROM ledger_entries le WHERE le.wallet_id = w.id), 0);--> statement-breakpoint
-- Every row has a wallet, and every account's wallets hold its old balance
-- plus exactly what was granted or topped up above.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM ledger_entries WHERE wallet_id IS NULL) THEN
    RAISE EXCEPTION 'venue_wallets: a ledger row has no wallet';
  END IF;
  IF EXISTS (
    SELECT 1 FROM accounts a
     WHERE a.balance_micro
           + coalesce((SELECT sum(x.delta_micro) FROM wallet_added x WHERE x.account_id = a.id), 0)
           <> coalesce((SELECT sum(w.balance_micro) FROM wallets w WHERE w.account_id = a.id), 0)
  ) THEN
    RAISE EXCEPTION 'venue_wallets: wallets do not add up to the old balances';
  END IF;
END $$;--> statement-breakpoint
DROP TABLE "wallet_added";--> statement-breakpoint
DROP TABLE "wallet_home";--> statement-breakpoint
ALTER TABLE "ledger_entries" ALTER COLUMN "wallet_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_wallet_id_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."wallets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ledger_entries_wallet_id_idx" ON "ledger_entries" USING btree ("wallet_id");--> statement-breakpoint
ALTER TABLE "accounts" DROP COLUMN "balance_micro";
