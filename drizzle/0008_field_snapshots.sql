CREATE TABLE "field_snapshots" (
	"basis" text PRIMARY KEY NOT NULL,
	"computed_at" timestamp with time zone NOT NULL,
	"worths_micro" bigint[] NOT NULL,
	"curve" double precision[] NOT NULL,
	"domain_lo" double precision NOT NULL,
	"domain_hi" double precision NOT NULL
);
