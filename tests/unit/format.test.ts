import { describe, expect, it } from 'vitest';
import { clock, day, dayMonth, payoutReturn } from '@/lib/format';

describe('payoutReturn', () => {
  it('is a multiple once the payout at least doubles the cost', () => {
    expect(payoutReturn(32_000_000n, 10_000_000n)).toBe('×3.20');
    expect(payoutReturn(20_000_000n, 10_000_000n)).toBe('×2.00');
  });

  it('is the gain as a percentage below that', () => {
    expect(payoutReturn(13_500_000n, 10_000_000n)).toBe('+35%');
    expect(payoutReturn(9_800_000n, 10_000_000n)).toBe('−2%');
  });

  it('has nothing to say about a zero cost', () => {
    expect(payoutReturn(1n, 0n)).toBeNull();
  });
});

describe('dates', () => {
  // Spelled out by hand so the server and the browser agree (hydration).
  it('are UTC with a three-letter month', () => {
    const at = '2026-09-13T23:30:00Z';
    expect(dayMonth(at)).toBe('13 Sep');
    expect(clock(at)).toBe('23:30');
    expect(day(at)).toBe('13 Sep 2026');
    expect(clock('2026-01-02T04:05:00Z')).toBe('04:05');
  });
});
