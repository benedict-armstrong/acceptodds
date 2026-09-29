CREATE TABLE "comment_backings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"comment_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"outcome_id" uuid NOT NULL,
	"shares_micro" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "comment_backings_shares_positive" CHECK ("comment_backings"."shares_micro" > 0)
);
--> statement-breakpoint
ALTER TABLE "comment_backings" ADD CONSTRAINT "comment_backings_comment_id_comments_id_fk" FOREIGN KEY ("comment_id") REFERENCES "public"."comments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment_backings" ADD CONSTRAINT "comment_backings_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment_backings" ADD CONSTRAINT "comment_backings_outcome_id_outcomes_id_fk" FOREIGN KEY ("outcome_id") REFERENCES "public"."outcomes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "comment_backings_account_outcome_created_idx" ON "comment_backings" USING btree ("account_id","outcome_id","created_at");--> statement-breakpoint
CREATE INDEX "comment_backings_comment_idx" ON "comment_backings" USING btree ("comment_id");