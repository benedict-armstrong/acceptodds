CREATE TABLE "group_reading_list" (
	"group_id" uuid NOT NULL,
	"listing_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "group_reading_list_group_id_listing_id_pk" PRIMARY KEY("group_id","listing_id")
);
--> statement-breakpoint
CREATE TABLE "listing_reads" (
	"account_id" uuid NOT NULL,
	"listing_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "listing_reads_account_id_listing_id_pk" PRIMARY KEY("account_id","listing_id")
);
--> statement-breakpoint
ALTER TABLE "group_reading_list" ADD CONSTRAINT "group_reading_list_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_reading_list" ADD CONSTRAINT "group_reading_list_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listing_reads" ADD CONSTRAINT "listing_reads_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listing_reads" ADD CONSTRAINT "listing_reads_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "group_reading_list_listing_idx" ON "group_reading_list" USING btree ("listing_id");--> statement-breakpoint
CREATE INDEX "listing_reads_listing_idx" ON "listing_reads" USING btree ("listing_id");