CREATE TABLE "pending_bets" (
	"user_id" text PRIMARY KEY NOT NULL,
	"market_id" uuid NOT NULL,
	"outcome_id" uuid NOT NULL,
	"stake_micro" bigint NOT NULL,
	"comment" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pending_bets_stake_positive" CHECK ("pending_bets"."stake_micro" > 0)
);
--> statement-breakpoint
ALTER TABLE "pending_bets" ADD CONSTRAINT "pending_bets_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_bets" ADD CONSTRAINT "pending_bets_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_bets" ADD CONSTRAINT "pending_bets_outcome_id_outcomes_id_fk" FOREIGN KEY ("outcome_id") REFERENCES "public"."outcomes"("id") ON DELETE cascade ON UPDATE no action;