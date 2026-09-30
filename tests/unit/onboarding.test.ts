import { describe, expect, it } from 'vitest';
import { parseChosenBet, welcomeBetHref } from '@/lib/onboarding';

describe('welcomeBetHref / parseChosenBet', () => {
  it('round-trips a bet through the URL, starting at the comment', () => {
    const bet = { marketId: 'm-1', outcomeId: 'o-2', stakeMicro: 100_000_000n, seenOrderCount: 7 };
    const url = new URL(welcomeBetHref(bet), 'https://x.test');
    expect(url.pathname).toBe('/welcome');
    expect(url.searchParams.get('step')).toBe('comment');
    expect(parseChosenBet(Object.fromEntries(url.searchParams))).toEqual(bet);
  });

  it.each([
    [{}],
    [{ market: 'm', outcome: 'o' }],
    [{ market: 'm', outcome: 'o', stake: '0', seen: '0' }],
    [{ market: 'm', outcome: 'o', stake: '-5', seen: '0' }],
    [{ market: 'm', outcome: 'o', stake: '1.5', seen: '0' }],
    [{ market: 'm', outcome: 'o', stake: '1e9', seen: '0' }],
    [{ market: 'm', outcome: 'o', stake: '99999999999999999999', seen: '0' }],
    [{ outcome: 'o', stake: '5', seen: '0' }],
    [{ market: 'm', outcome: 'o', stake: '5' }],
    [{ market: 'm', outcome: 'o', stake: '5', seen: '-1' }],
    [{ market: 'm', outcome: 'o', stake: '5', seen: 'x' }],
  ])('rejects %j', (params) => {
    expect(parseChosenBet(params)).toBeNull();
  });
});
