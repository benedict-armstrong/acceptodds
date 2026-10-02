CREATE TABLE "comment_aliases" (
	"listing_id" uuid,
	"market_id" uuid,
	"account_id" uuid NOT NULL,
	"alias" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "comment_aliases_one_scope" CHECK (("comment_aliases"."listing_id" is null) <> ("comment_aliases"."market_id" is null))
);
--> statement-breakpoint
ALTER TABLE "comment_aliases" ADD CONSTRAINT "comment_aliases_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment_aliases" ADD CONSTRAINT "comment_aliases_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment_aliases" ADD CONSTRAINT "comment_aliases_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "comment_aliases_listing_account_key" ON "comment_aliases" USING btree ("listing_id","account_id") WHERE "comment_aliases"."listing_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "comment_aliases_listing_alias_key" ON "comment_aliases" USING btree ("listing_id","alias") WHERE "comment_aliases"."listing_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "comment_aliases_market_account_key" ON "comment_aliases" USING btree ("market_id","account_id") WHERE "comment_aliases"."market_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "comment_aliases_market_alias_key" ON "comment_aliases" USING btree ("market_id","alias") WHERE "comment_aliases"."market_id" is not null;--> statement-breakpoint
-- Every account that has already commented gets its alias on that paper, as
-- server/comments.ts would make it: 4 characters of ALIAS_ALPHABET, drawn
-- again on a clash within the scope.
DO $$
DECLARE
  r record;
  a text;
BEGIN
  FOR r IN
    SELECT DISTINCT m.listing_id, CASE WHEN m.listing_id IS NULL THEN m.id END AS market_id, c.account_id
    FROM comments c JOIN markets m ON m.id = c.market_id
  LOOP
    LOOP
      SELECT string_agg(substr('abcdefghjkmnpqrstuvwxyz23456789', 1 + floor(random() * 31)::int, 1), '')
        INTO a FROM generate_series(1, 4);
      BEGIN
        INSERT INTO comment_aliases (listing_id, market_id, account_id, alias)
          VALUES (r.listing_id, r.market_id, r.account_id, a);
        EXIT;
      EXCEPTION WHEN unique_violation THEN
        -- the alias is taken in this scope: draw again
      END;
    END LOOP;
  END LOOP;
END $$;
