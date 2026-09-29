-- Full-text search documents for listings and markets (issue #8).
--
-- Immutable, so they can back the expression GIN indexes in the next
-- migration. `array_to_string` is only STABLE in general (element output
-- functions may depend on settings), but on text[] it is not, which is why a
-- wrapper is sound here and why a generated column could not call it directly.
-- Weights: A = title / question, B = authors, C = summary / description.
-- Changing a document means a new migration that replaces the function and
-- rebuilds its index.
CREATE FUNCTION listing_search_vector(title text, authors text[], summary text)
RETURNS tsvector
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
  SELECT setweight(pg_catalog.to_tsvector('pg_catalog.english'::regconfig, coalesce(title, '')), 'A')
      || setweight(pg_catalog.to_tsvector('pg_catalog.english'::regconfig, coalesce(pg_catalog.array_to_string(authors, ' '), '')), 'B')
      || setweight(pg_catalog.to_tsvector('pg_catalog.english'::regconfig, coalesce(summary, '')), 'C')
$$;
--> statement-breakpoint
CREATE FUNCTION market_search_vector(question text, description text)
RETURNS tsvector
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
  SELECT setweight(pg_catalog.to_tsvector('pg_catalog.english'::regconfig, coalesce(question, '')), 'A')
      || setweight(pg_catalog.to_tsvector('pg_catalog.english'::regconfig, coalesce(description, '')), 'C')
$$;
