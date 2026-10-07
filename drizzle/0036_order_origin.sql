ALTER TABLE "orders" ADD COLUMN "via" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "is_llm" boolean DEFAULT false NOT NULL;