CREATE SEQUENCE "public"."short_ids" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "short_id" bigint DEFAULT nextval('short_ids') NOT NULL;--> statement-breakpoint
ALTER TABLE "markets" ADD COLUMN "short_id" bigint DEFAULT nextval('short_ids') NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "listings_short_id_key" ON "listings" USING btree ("short_id");--> statement-breakpoint
CREATE UNIQUE INDEX "markets_short_id_key" ON "markets" USING btree ("short_id");