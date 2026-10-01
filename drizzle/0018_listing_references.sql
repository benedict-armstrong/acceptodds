CREATE TABLE "listing_references" (
	"listing_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"title" text NOT NULL,
	"authors" text[] DEFAULT '{}'::text[] NOT NULL,
	"year" integer,
	"url" text,
	"cited_slug" text,
	CONSTRAINT "listing_references_listing_id_position_pk" PRIMARY KEY("listing_id","position")
);
--> statement-breakpoint
ALTER TABLE "listing_references" ADD CONSTRAINT "listing_references_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "listing_references_cited_idx" ON "listing_references" USING btree ("cited_slug") WHERE "listing_references"."cited_slug" is not null;