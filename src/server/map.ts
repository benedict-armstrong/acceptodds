import { getDb, type Database } from '@/db';
import { mapPoints, mapTopics } from '@/db/schema';

/**
 * The paper map's writer. The layout is computed elsewhere (a separate
 * service embeds and lays out the papers) and supplied whole; nothing here
 * interprets a coordinate or a grouping. Not market state, so never the
 * engine's business, and nothing it writes moves a balance.
 */

export interface MapPointInput {
  /** A listing's slug. Matched when read, so it need not be listed yet. */
  slug: string;
  x: number;
  y: number;
  region?: number | null;
  cluster?: number | null;
  /** The service's compressed embedding; every point's the same length. Only cosine distances are read. */
  vector?: number[] | null;
}

export interface MapTopicInput {
  number: number;
  label: string;
}

export interface MapInput {
  points: MapPointInput[];
  regions: MapTopicInput[];
  clusters: MapTopicInput[];
}

/** Rows per insert: six parameters a row, well under Postgres's 65,535. */
const CHUNK = 5000;

/**
 * Replace the whole map, in one transaction, so a reader sees the old map or
 * the new one and never half of each. A repeated slug keeps its first point.
 */
export async function setMap(input: MapInput, database: Database = getDb()): Promise<number> {
  const seen = new Set<string>();
  const points = input.points.filter((p) => !seen.has(p.slug) && seen.add(p.slug));
  const topics = [
    ...input.regions.map((t) => ({ level: 'region', ...t })),
    ...input.clusters.map((t) => ({ level: 'cluster', ...t })),
  ];
  await database.transaction(async (tx) => {
    await tx.delete(mapPoints);
    await tx.delete(mapTopics);
    for (let i = 0; i < points.length; i += CHUNK) {
      await tx.insert(mapPoints).values(
        points.slice(i, i + CHUNK).map((p) => ({
          slug: p.slug,
          x: p.x,
          y: p.y,
          region: p.region ?? null,
          cluster: p.cluster ?? null,
          vector: p.vector ?? null,
        })),
      );
    }
    if (topics.length > 0) await tx.insert(mapTopics).values(topics).onConflictDoNothing();
  });
  return points.length;
}
