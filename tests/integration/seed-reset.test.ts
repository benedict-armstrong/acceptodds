import { afterAll, beforeEach, expect, it } from 'vitest';
import { getDb } from '@/db';
import { accounts, listings, listingReferences, listingRelated, mapPoints, mapTopics, markets } from '@/db/schema';
import { wipeSeedData } from '@/db/seed-reset';
import { setRelated, upsertListing } from '@/server/listings';
import { setMap } from '@/server/map';
import { closePool, resetDatabase, seedMarket } from './helpers';

const db = getDb();

beforeEach(async () => {
  await resetDatabase();
  await seedMarket(1);
  const { listing } = await upsertListing({
    slug: 'preserved-paper',
    title: 'Preserved paper',
    references: [{ title: 'A reference' }],
  });
  await setRelated(listing, [{ slug: 'another-paper', score: 0.9 }]);
  await setMap({
    points: [{ slug: listing.slug, x: 1, y: 2, region: 0, vector: [1, -2, 3] }],
    regions: [{ number: 0, label: 'Region' }],
    clusters: [],
  });
}, 60_000);

afterAll(closePool);

it('preserves paper rows and vectors by default while wiping accounts and markets', async () => {
  const papers = await db.select().from(listings);
  const references = await db.select().from(listingReferences);
  const related = await db.select().from(listingRelated);
  const points = await db.select().from(mapPoints);
  const topics = await db.select().from(mapTopics);

  await wipeSeedData(db);

  expect(await db.select().from(listings)).toEqual(papers);
  expect(await db.select().from(listingReferences)).toEqual(references);
  expect(await db.select().from(listingRelated)).toEqual(related);
  expect(await db.select().from(mapPoints)).toEqual(points);
  expect(await db.select().from(mapTopics)).toEqual(topics);
  expect(await db.select().from(accounts)).toEqual([]);
  expect(await db.select().from(markets)).toEqual([]);
});

it('clears paper data only when explicitly requested', async () => {
  await wipeSeedData(db, false);

  expect(await db.select().from(listings)).toEqual([]);
  expect(await db.select().from(listingReferences)).toEqual([]);
  expect(await db.select().from(listingRelated)).toEqual([]);
  expect(await db.select().from(mapPoints)).toEqual([]);
  expect(await db.select().from(mapTopics)).toEqual([]);
});
