import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { trade } from '@/server/engine';
import { firstFill, marketView, resolveMarket } from '@/server/views';
import { closePool, resetDatabase, seedMarket } from './helpers';

beforeEach(async () => {
  await resetDatabase();
}, 60_000);

afterAll(async () => {
  await closePool();
});

const MAX = 1_000_000_000n;

describe('firstFill', () => {
  it('is null before any trade', async () => {
    const f = await seedMarket(1);
    expect(await firstFill(f.traderIds[0])).toBeNull();
  });

  it('replays the price before and after the first fill, ignoring later fills', async () => {
    const f = await seedMarket(2);
    const [yes, no] = f.outcomeIds;
    // Someone else moves the market first, so "before" is not the opening price.
    await trade(f.traderIds[1], f.marketId, no, 30_000_000n, MAX);
    const before = (await marketView(await resolveMarket(f.marketId))).outcomes[0].price;
    const fill = await trade(f.traderIds[0], f.marketId, yes, 20_000_000n, MAX);
    const after = (await marketView(await resolveMarket(f.marketId))).outcomes[0].price;
    // Later fills, theirs and others', change neither.
    await trade(f.traderIds[0], f.marketId, yes, 10_000_000n, MAX);
    await trade(f.traderIds[1], f.marketId, no, 10_000_000n, MAX);

    const first = await firstFill(f.traderIds[0]);
    expect(first).toMatchObject({ label: 'YES', costMicro: fill.costMicro });
    expect(before).toBeLessThan(0.5);
    expect(first!.priceBefore).toBeCloseTo(before, 12);
    expect(first!.priceAfter).toBeCloseTo(after, 12);
    expect(first!.priceAfter).toBeGreaterThan(first!.priceBefore);
  });
});
