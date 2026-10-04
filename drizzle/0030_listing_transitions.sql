CREATE TABLE "listing_transition_visits" (
	"day" date NOT NULL,
	"visitor" text NOT NULL,
	CONSTRAINT "listing_transition_visits_day_visitor_pk" PRIMARY KEY("day","visitor")
);
--> statement-breakpoint
CREATE TABLE "listing_transitions" (
	"from_listing_id" uuid NOT NULL,
	"to_listing_id" uuid NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "listing_transitions_from_listing_id_to_listing_id_pk" PRIMARY KEY("from_listing_id","to_listing_id")
);
