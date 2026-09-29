-- Fuzzy people search (issue #10): `views.searchPeople` matches a trader's
-- handle and display name by substring (ILIKE) or trigram word similarity
-- (`<%`), and both can use this index. pg_trgm is a trusted extension since
-- Postgres 13, so the database owner may create it.
--
-- The indexed expression is not in `schema.ts`; `searchPeople` must write it
-- exactly as `handle || ' ' || display_name` for the planner to use it.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE INDEX accounts_people_trgm_idx ON accounts USING gin ((handle || ' ' || display_name) gin_trgm_ops);
