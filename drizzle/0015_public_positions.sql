CREATE TABLE "public_positions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"outcome_id" uuid NOT NULL,
	"shared_shares_micro" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "public_positions_shares_positive" CHECK ("public_positions"."shared_shares_micro" > 0)
);
--> statement-breakpoint
ALTER TABLE "public_positions" ADD CONSTRAINT "public_positions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "public_positions" ADD CONSTRAINT "public_positions_outcome_id_outcomes_id_fk" FOREIGN KEY ("outcome_id") REFERENCES "public"."outcomes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "public_positions_account_outcome_key" ON "public_positions" USING btree ("account_id","outcome_id");