CREATE TABLE "listing_texts" (
	"listing_id" uuid PRIMARY KEY NOT NULL,
	"body" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "listing_texts" ADD CONSTRAINT "listing_texts_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE cascade ON UPDATE no action;