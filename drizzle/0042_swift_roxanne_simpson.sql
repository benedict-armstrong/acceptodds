CREATE INDEX "listings_kind_id_idx" ON "listings" USING btree ("kind","id");--> statement-breakpoint
-- The index above serves the home list as an index-only scan only while the
-- visibility map is fresh, and every counted view (`view-counter.ts`) dirties
-- a page of it. Autovacuum's default waits for 20% of the table to be dead
-- (~9k rows at 43k listings), which left 29% of it all-visible; 1% keeps it
-- current, and a vacuum that only visits dirtied pages is cheap.
ALTER TABLE "listings" SET (autovacuum_vacuum_scale_factor = 0.01);
