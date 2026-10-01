CREATE TABLE "listing_views" (
	"listing_id" uuid NOT NULL,
	"day" date NOT NULL,
	"visitor" text NOT NULL,
	CONSTRAINT "listing_views_listing_id_day_visitor_pk" PRIMARY KEY("listing_id","day","visitor")
);
--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "view_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "listing_views_day_idx" ON "listing_views" USING btree ("day");