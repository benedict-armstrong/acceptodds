CREATE TABLE "digest_sends" (
	"account_id" uuid NOT NULL,
	"day" date NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "digest_sends_account_id_day_pk" PRIMARY KEY("account_id","day")
);
--> statement-breakpoint
CREATE TABLE "listing_follows" (
	"account_id" uuid NOT NULL,
	"listing_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "listing_follows_account_id_listing_id_pk" PRIMARY KEY("account_id","listing_id")
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "digest_opt_in" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "digest_sends" ADD CONSTRAINT "digest_sends_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listing_follows" ADD CONSTRAINT "listing_follows_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listing_follows" ADD CONSTRAINT "listing_follows_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "listing_follows_listing_idx" ON "listing_follows" USING btree ("listing_id");