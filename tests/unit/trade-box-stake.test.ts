import { describe, expect, it } from 'vitest';
import { defaultStake } from '@/app/markets/[slug]/TradeBox';

describe('defaultStake', () => {
  it('is 100 signed out or with 100 or more', () => {
    expect(defaultStake(null)).toBe('100');
    expect(defaultStake(100_000_000n)).toBe('100');
    expect(defaultStake(1_000_000_000n)).toBe('100');
  });

  it('is the whole balance below 100, cut to cents', () => {
    expect(defaultStake(42_000_000n)).toBe('42');
    expect(defaultStake(42_509_999n)).toBe('42.50');
    expect(defaultStake(0n)).toBe('0');
    expect(defaultStake(-5n)).toBe('0');
  });
});
