CREATE TYPE "public"."token_scope" AS ENUM('read', 'trade', 'admin');--> statement-breakpoint
CREATE TABLE "rate_limit_buckets" (
	"key" text PRIMARY KEY NOT NULL,
	"tokens" double precision NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "api_tokens" ADD COLUMN "scopes" "token_scope"[] DEFAULT '{read}' NOT NULL;