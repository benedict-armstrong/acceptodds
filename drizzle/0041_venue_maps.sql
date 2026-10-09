-- One map per venue. The map supplied so far is one venue's: each point takes
-- its listing's venue (the listing's kind, else its main market's), and the
-- points no listing names, and every topic, take the venue most points have.
ALTER TABLE "map_points" ADD COLUMN "kind" text;--> statement-breakpoint
ALTER TABLE "map_topics" ADD COLUMN "kind" text;--> statement-breakpoint
UPDATE "map_points" p SET "kind" = coalesce(l."kind", m."kind")
  FROM "listings" l LEFT JOIN "markets" m ON m."listing_id" = l."id" AND m."is_main"
 WHERE l."slug" = p."slug";--> statement-breakpoint
UPDATE "map_points" SET "kind" = (
  SELECT "kind" FROM "map_points" WHERE "kind" IS NOT NULL GROUP BY "kind" ORDER BY count(*) DESC, "kind" LIMIT 1
) WHERE "kind" IS NULL;--> statement-breakpoint
UPDATE "map_topics" SET "kind" = (
  SELECT "kind" FROM "map_points" GROUP BY "kind" ORDER BY count(*) DESC, "kind" LIMIT 1
);--> statement-breakpoint
-- No venue to give them: a map no listing has been named on yet.
DELETE FROM "map_points" WHERE "kind" IS NULL;--> statement-breakpoint
DELETE FROM "map_topics" WHERE "kind" IS NULL;--> statement-breakpoint
ALTER TABLE "map_points" ALTER COLUMN "kind" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "map_topics" ALTER COLUMN "kind" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "map_points" DROP CONSTRAINT "map_points_pkey";--> statement-breakpoint
ALTER TABLE "map_topics" DROP CONSTRAINT "map_topics_level_number_pk";--> statement-breakpoint
ALTER TABLE "map_points" ADD CONSTRAINT "map_points_kind_slug_pk" PRIMARY KEY("kind","slug");--> statement-breakpoint
ALTER TABLE "map_topics" ADD CONSTRAINT "map_topics_kind_level_number_pk" PRIMARY KEY("kind","level","number");
