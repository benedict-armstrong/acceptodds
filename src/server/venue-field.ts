import { and, asc, eq, gt, inArray, isNotNull } from 'drizzle-orm';
import { getDb, type Database } from '@/db';
import { markets, type Market } from '@/db/schema';

/**
 * Where a paper's headline sits among the papers at its venue (the paper
 * page's "Among papers at …" figure): the histogram of the headlines of
 * every trading main market of the same `kind`, read from the
 * `markets.headline` cache (#12). **Reads only.** A headline is a price, never
 * a value (§1.1).
 *
 * Markets nobody has traded are left out too: they all sit at their opening price, which
 * is no one's belief and would pile into one bar. Settled markets are left out (their headline is 1 or 0, a result, not a
 * belief), as are void ones, drafts and a listing's secondary markets, whose
 * questions are not the venue's decision. The counts are cached per venue for a
 * minute: it moves with every fill but nobody needs it exact; a viewer's own
 * marker is placed from the live headline.
 */

export interface VenueField {
  kind: string;
  /** Papers per `BINS` equal-width bins across 0–100%, the last closed at 100. */
  bins: number[];
  /** At most `SAMPLE` headlines in percent, ascending, evenly spaced through the field's order. For hover and percentiles. */
  values: number[];
}

export const BINS = 20;
const SAMPLE = 200;
/** One paper alone has nothing to be placed among. */
const MIN_FIELD = 2;
const TTL_MS = 60_000;

const cache = new Map<string, { at: number; field: VenueField | null }>();

/** `null` when `market` is not one a venue field applies to, or its venue is too small. */
export async function venueField(market: Market, database: Database = getDb()): Promise<VenueField | null> {
  if (!market.isMain || (market.status !== 'open' && market.status !== 'closed')) return null;
  const hit = cache.get(market.kind);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.field;

  const rows = await database
    .select({ headline: markets.headline })
    .from(markets)
    .where(
      and(
        eq(markets.kind, market.kind),
        eq(markets.isMain, true),
        inArray(markets.status, ['open', 'closed']),
        isNotNull(markets.headline),
        gt(markets.orderCount, 0),
      ),
    )
    .orderBy(asc(markets.headline));
  const percents = rows.map((r) => (r.headline ?? 0) * 100);
  let field: VenueField | null = null;
  if (percents.length >= MIN_FIELD) {
    const bins = Array.from({ length: BINS }, () => 0);
    for (const x of percents) bins[Math.min(BINS - 1, Math.floor((x / 100) * BINS))] += 1;
    const values =
      percents.length > SAMPLE
        ? Array.from({ length: SAMPLE }, (_, i) => percents[Math.round((i * (percents.length - 1)) / (SAMPLE - 1))])
        : percents;
    field = { kind: market.kind, bins, values };
  }
  cache.set(market.kind, { at: Date.now(), field });
  return field;
}
