-- Browse lists and search at venue scale (issue #12): 30k papers.
--
-- Stored search vectors, deliberately not in src/db/schema.ts (see the comment
-- on listings_search_idx there): the GIN indexes below are on these columns.
ALTER TABLE "listings" ADD COLUMN "search_vector" tsvector GENERATED ALWAYS AS (listing_search_vector(title, authors, summary)) STORED;--> statement-breakpoint
ALTER TABLE "markets" ADD COLUMN "search_vector" tsvector GENERATED ALWAYS AS (market_search_vector(question, description)) STORED;--> statement-breakpoint
DROP INDEX "listings_search_idx";--> statement-breakpoint
DROP INDEX "markets_search_idx";--> statement-breakpoint
ALTER TABLE "markets" ADD COLUMN "is_main" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "markets" ADD COLUMN "volume_micro" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "markets" ADD COLUMN "order_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "markets" ADD COLUMN "last_trade_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "markets" ADD COLUMN "headline" double precision;--> statement-breakpoint
-- Backfill: each listing's main market, standalone markets, and the fill caches.
UPDATE "markets" m SET "is_main" = true
 WHERE m.status <> 'draft'
   AND (m.listing_id IS NULL OR m.id = (
     SELECT m2.id FROM "markets" m2
      WHERE m2.listing_id = m.listing_id AND m2.status <> 'draft'
      ORDER BY m2.listing_rank, m2.created_at, m2.id
      LIMIT 1));--> statement-breakpoint
UPDATE "markets" m SET "volume_micro" = s.volume, "order_count" = s.n, "last_trade_at" = s.last
  FROM (SELECT market_id, sum(abs(cost_micro))::bigint AS volume, count(*)::int AS n, max(created_at) AS last
          FROM "orders" GROUP BY market_id) s
 WHERE s.market_id = m.id;--> statement-breakpoint
-- The headline, 1 - P(last outcome) (lib/headline.ts), exponents clamped as in views.ts.
UPDATE "markets" m SET "headline" = 1 - 1 / (
    SELECT sum(exp(least(greatest((o.shares_micro - l.shares_micro)::float8 / m.b, -700), 700)))
      FROM "outcomes" o WHERE o.market_id = m.id)
  FROM "outcomes" l
 WHERE l.market_id = m.id AND l.ordinal > 0
   AND l.ordinal = (SELECT max(x.ordinal) FROM "outcomes" x WHERE x.market_id = m.id);--> statement-breakpoint
-- Settled, 1 or 0 by the result; void, none.
UPDATE "markets" m SET "headline" = (m.resolved_outcome_id <> l.id)::int::float8
  FROM "outcomes" l
 WHERE m.status = 'settled' AND l.market_id = m.id AND l.ordinal > 0
   AND l.ordinal = (SELECT max(x.ordinal) FROM "outcomes" x WHERE x.market_id = m.id);--> statement-breakpoint
UPDATE "markets" SET "headline" = NULL WHERE status = 'void';--> statement-breakpoint
CREATE INDEX "listings_created_idx" ON "listings" USING btree ("created_at","id");--> statement-breakpoint
CREATE INDEX "markets_created_idx" ON "markets" USING btree ("created_at","id");--> statement-breakpoint
CREATE INDEX "markets_main_idx" ON "markets" USING btree ("kind","status") WHERE is_main;--> statement-breakpoint
CREATE UNIQUE INDEX "markets_main_per_listing_key" ON "markets" USING btree ("listing_id") WHERE is_main;--> statement-breakpoint
CREATE INDEX "markets_secondary_idx" ON "markets" USING btree ("listing_id") WHERE not is_main and status <> 'draft';--> statement-breakpoint
CREATE INDEX "listings_search_idx" ON "listings" USING gin (search_vector);--> statement-breakpoint
CREATE INDEX "markets_search_idx" ON "markets" USING gin (search_vector);