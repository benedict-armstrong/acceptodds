import { describe, expect, it } from 'vitest';
import { marketPollInterval, tapePollInterval } from '@/lib/market-poll';

const now = Date.now();
const open = { status: 'open', orderCount: 2, closesAt: new Date(now + 60_000).toISOString() };

describe('market polling', () => {
  it('backs off quiet markets and stops settled boards', () => {
    expect(marketPollInterval(open, now)).toBe(5000);
    expect(marketPollInterval({ ...open, orderCount: 0 }, now)).toBe(15_000);
    for (const status of ['settled', 'void']) {
      expect(marketPollInterval({ ...open, status }, now)).toBe(0);
      expect(tapePollInterval({ ...open, status }, now)).toBe(0);
    }
  });
  it('checks closed markets for resolution while stopping tape polling', () => {
    expect(marketPollInterval({ ...open, status: 'closed' }, now)).toBe(30_000);
    expect(tapePollInterval({ ...open, status: 'closed' }, now)).toBe(0);
    expect(marketPollInterval(open, now + 60_000)).toBe(30_000);
    expect(tapePollInterval(open, now + 60_000)).toBe(0);
  });
});
