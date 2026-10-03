CREATE TABLE "listing_related" (
	"listing_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"related_slug" text NOT NULL,
	"score" double precision NOT NULL,
	CONSTRAINT "listing_related_listing_id_position_pk" PRIMARY KEY("listing_id","position")
);
--> statement-breakpoint
ALTER TABLE "listing_related" ADD CONSTRAINT "listing_related_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "listing_related_slug_idx" ON "listing_related" USING btree ("related_slug");