CREATE TYPE "public"."ledger_reason" AS ENUM('signup', 'trade', 'settlement', 'subsidy', 'adjustment');--> statement-breakpoint
CREATE TYPE "public"."market_status" AS ENUM('draft', 'open', 'closed', 'settled', 'void');--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text,
	"handle" text NOT NULL,
	"display_name" text NOT NULL,
	"orcid" text,
	"ror_id" text,
	"institution_name" text,
	"verified_at" timestamp with time zone,
	"balance_micro" bigint DEFAULT 0 NOT NULL,
	"is_bot" boolean DEFAULT false NOT NULL,
	"is_house" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"prefix" text NOT NULL,
	"token_hash" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"account_id" uuid,
	"market_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"delta_micro" bigint NOT NULL,
	"reason" "ledger_reason" NOT NULL,
	"order_id" uuid,
	"market_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "markets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"question" text NOT NULL,
	"description" text,
	"kind" text DEFAULT 'binary' NOT NULL,
	"status" "market_status" DEFAULT 'draft' NOT NULL,
	"b" double precision NOT NULL,
	"maker_account_id" uuid NOT NULL,
	"opens_at" timestamp with time zone,
	"closes_at" timestamp with time zone NOT NULL,
	"resolution_source" text,
	"resolved_outcome_id" uuid,
	"resolution_evidence_url" text,
	"settled_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"market_id" uuid NOT NULL,
	"outcome_id" uuid NOT NULL,
	"shares_micro" bigint NOT NULL,
	"cost_micro" bigint NOT NULL,
	"price_before" double precision NOT NULL,
	"price_after" double precision NOT NULL,
	"idempotency_key" text,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outcomes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"market_id" uuid NOT NULL,
	"label" text NOT NULL,
	"ordinal" integer NOT NULL,
	"shares_micro" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "positions" (
	"account_id" uuid NOT NULL,
	"outcome_id" uuid NOT NULL,
	"shares_micro" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "positions_account_id_outcome_id_pk" PRIMARY KEY("account_id","outcome_id")
);
--> statement-breakpoint
CREATE TABLE "usd_costs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"amount_usd_micro" bigint NOT NULL,
	"incurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "markets" ADD CONSTRAINT "markets_maker_account_id_accounts_id_fk" FOREIGN KEY ("maker_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "markets" ADD CONSTRAINT "markets_created_by_accounts_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_outcome_id_outcomes_id_fk" FOREIGN KEY ("outcome_id") REFERENCES "public"."outcomes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outcomes" ADD CONSTRAINT "outcomes_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_outcome_id_outcomes_id_fk" FOREIGN KEY ("outcome_id") REFERENCES "public"."outcomes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_handle_key" ON "accounts" USING btree ("handle");--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_user_id_key" ON "accounts" USING btree ("user_id") WHERE user_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_orcid_key" ON "accounts" USING btree ("orcid") WHERE orcid is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "api_tokens_prefix_key" ON "api_tokens" USING btree ("prefix");--> statement-breakpoint
CREATE INDEX "api_tokens_account_id_idx" ON "api_tokens" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "events_created_at_idx" ON "events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "events_kind_created_idx" ON "events" USING btree ("kind","created_at");--> statement-breakpoint
CREATE INDEX "ledger_entries_account_id_idx" ON "ledger_entries" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "ledger_entries_order_id_idx" ON "ledger_entries" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "markets_slug_key" ON "markets" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "markets_status_idx" ON "markets" USING btree ("status");--> statement-breakpoint
CREATE INDEX "orders_market_created_idx" ON "orders" USING btree ("market_id","created_at");--> statement-breakpoint
CREATE INDEX "orders_account_id_idx" ON "orders" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_account_idempotency_key" ON "orders" USING btree ("account_id","idempotency_key") WHERE idempotency_key is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "outcomes_market_ordinal_key" ON "outcomes" USING btree ("market_id","ordinal");--> statement-breakpoint
CREATE INDEX "outcomes_market_id_idx" ON "outcomes" USING btree ("market_id");--> statement-breakpoint
CREATE INDEX "positions_account_id_idx" ON "positions" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "positions_outcome_id_idx" ON "positions" USING btree ("outcome_id");--> statement-breakpoint
CREATE INDEX "usd_costs_incurred_at_idx" ON "usd_costs" USING btree ("incurred_at");