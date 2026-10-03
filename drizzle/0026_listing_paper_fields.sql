ALTER TABLE "listings" ADD COLUMN "author_ids" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "keywords" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "primary_area" text;--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "tldr" text;