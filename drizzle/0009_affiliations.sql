CREATE TABLE "affiliations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"email" text NOT NULL,
	"institution_name" text NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"code_hash" text,
	"code_expires_at" timestamp with time zone,
	"code_attempts" integer DEFAULT 0 NOT NULL,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "institutions" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "affiliations" ADD CONSTRAINT "affiliations_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "affiliations_account_email_key" ON "affiliations" USING btree ("account_id","email");--> statement-breakpoint
CREATE UNIQUE INDEX "affiliations_verified_email_key" ON "affiliations" USING btree ("email") WHERE verified_at is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "affiliations_primary_key" ON "affiliations" USING btree ("account_id") WHERE is_primary;--> statement-breakpoint
-- Backfill: a confirmed sign-up address becomes the account's primary affiliation.
INSERT INTO "affiliations" ("account_id", "email", "institution_name", "is_primary", "verified_at")
SELECT a."id", lower(u."email"), a."institution_name", true, a."verified_at"
  FROM "accounts" a
  JOIN "user" u ON u."id" = a."user_id"
 WHERE a."institution_name" IS NOT NULL AND a."verified_at" IS NOT NULL AND NOT a."is_bot";--> statement-breakpoint
UPDATE "accounts" SET "institutions" = ARRAY["institution_name"] WHERE "institution_name" IS NOT NULL;
