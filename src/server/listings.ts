import { eq, getTableColumns, sql } from 'drizzle-orm';
import { getDb, type Database } from '@/db';
import { listingReferences, listings, type Listing, type ListingLink } from '@/db/schema';

/**
 * Writing listings. A listing is an **opaque subject** that markets can be
 * grouped under — a title, a summary, names, labelled links and a
 * bibliography (`listing_references`, #38), all supplied by the creating
 * client (`../research`). The venue never fetches, checks or
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
  /** The bibliography, in order (#38). Replaced whole, like every other field. */
  references?: ReferenceInput[];
}

export interface ReferenceInput {
  title: string;
  authors?: string[];
  year?: number | null;
  venue?: string | null;
  url?: string | null;
  /** The cited work's listing slug, if it has (or may get) one here. Matched when read. */
  citedSlug?: string | null;
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
    await tx.delete(listingReferences).where(eq(listingReferences.listingId, listing.id));
    const refs = input.references ?? [];
    if (refs.length > 0) {
      await tx.insert(listingReferences).values(
        refs.map((r, position) => ({
          listingId: listing.id,
          position,
          title: r.title,
          authors: r.authors ?? [],
          year: r.year ?? null,
          venue: r.venue ?? null,
          url: r.url ?? null,
          citedSlug: r.citedSlug ?? null,
        })),
      );
    }
    return { listing, created };
  });
}
