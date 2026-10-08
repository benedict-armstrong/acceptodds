CREATE TABLE "comment_mentions" (
	"comment_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	CONSTRAINT "comment_mentions_comment_id_account_id_pk" PRIMARY KEY("comment_id","account_id")
);
--> statement-breakpoint
ALTER TABLE "comment_mentions" ADD CONSTRAINT "comment_mentions_comment_id_comments_id_fk" FOREIGN KEY ("comment_id") REFERENCES "public"."comments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment_mentions" ADD CONSTRAINT "comment_mentions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "comment_mentions_account_idx" ON "comment_mentions" USING btree ("account_id");