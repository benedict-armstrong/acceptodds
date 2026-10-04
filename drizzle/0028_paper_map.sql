CREATE TABLE "map_points" (
	"slug" text PRIMARY KEY NOT NULL,
	"x" double precision NOT NULL,
	"y" double precision NOT NULL,
	"region" integer,
	"cluster" integer
);
--> statement-breakpoint
CREATE TABLE "map_topics" (
	"level" text NOT NULL,
	"number" integer NOT NULL,
	"label" text NOT NULL,
	CONSTRAINT "map_topics_level_number_pk" PRIMARY KEY("level","number"),
	CONSTRAINT "map_topics_level" CHECK ("map_topics"."level" in ('region', 'cluster'))
);
