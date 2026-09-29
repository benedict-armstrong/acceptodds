import { getTableColumns, sql } from 'drizzle-orm';
import { getDb, type Database } from '@/db';
import { listings, type Listing, type ListingLink } from '@/db/schema';

/**
 * Writing listings. A listing is an **opaque subject** that markets can be
 * grouped under — a title, a summary, names and labelled links, all supplied
 * by the creating client (`../research`). The venue never fetches, checks or
 * interprets any of it; only the UI calls a listing a "paper".
 *
 * This is not market state: no money, no shares, no prices. It is written
 * here, in its own small transaction, and never by the engine or inside a
 * trade. A market is attached to a listing when the engine creates it.
 */

export interface UpsertListingInput {
  slug: string;
  title: string;
  summary?: string | null;
  authors?: string[];
  links?: ListingLink[];
  kind?: string | null;
}

/**
 * Create the listing with this slug, or replace every field of the existing
 * one. A full replacement, so repeating a call is a no-op and a field left out
 * is cleared rather than silently kept.
 */
export async function upsertListing(
  input: UpsertListingInput,
  database: Database = getDb(),
): Promise<{ listing: Listing; created: boolean }> {
  const values = {
    title: input.title,
    summary: input.summary ?? null,
    authors: input.authors ?? [],
    links: input.links ?? [],
    kind: input.kind ?? null,
  };
  return database.transaction(async (tx) => {
    const [{ created, ...listing }] = await tx
      .insert(listings)
      .values({ slug: input.slug, ...values })
      .onConflictDoUpdate({ target: listings.slug, set: values })
      // `xmax = 0` holds only for a row version this statement inserted.
      .returning({ ...getTableColumns(listings), created: sql<boolean>`(xmax = 0)` });
    return { listing, created };
  });
}
