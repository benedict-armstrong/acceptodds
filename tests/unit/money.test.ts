import { describe, expect, it } from 'vitest';
import {
  costToMicro,
  formatMicro,
  microToFloat,
  microToUnits,
  sharesToMicro,
  unitsToMicro,
} from '@/lib/money';

describe('money', () => {
  it('rounds every cost in the house favour, in both directions', () => {
    // A buy: the trader pays the extra fraction.
    expect(costToMicro(10.2)).toBe(11n);
    expect(costToMicro(10.0)).toBe(10n);
    // A sell: the trader receives the smaller amount.
    expect(costToMicro(-10.2)).toBe(-10n);
    expect(costToMicro(-10.8)).toBe(-10n);
  });

  it('rounds shares to nearest, half away from zero', () => {
    expect(sharesToMicro(10.5)).toBe(11n);
    expect(sharesToMicro(-10.5)).toBe(-11n);
    expect(sharesToMicro(10.4)).toBe(10n);
  });

  it('converts units and back', () => {
    expect(unitsToMicro(1.5)).toBe(1_500_000n);
    expect(unitsToMicro(-0.000001)).toBe(-1n);
    expect(microToUnits(1_500_000n)).toBe(1.5);
    expect(microToFloat(1_500_000n)).toBe(1_500_000);
  });

  it('refuses to guess past the safe integer range rather than lose units', () => {
    expect(() => costToMicro(Number.MAX_SAFE_INTEGER * 2)).toThrow(RangeError);
    expect(() => microToFloat(2n ** 60n)).toThrow(RangeError);
    expect(() => costToMicro(Infinity)).toThrow(RangeError);
  });

  it('formats', () => {
    expect(formatMicro(1_500_000n)).toBe('1.50');
    expect(formatMicro(-1_500_000n)).toBe('-1.50');
    expect(formatMicro(999_999n, 6)).toBe('0.999999');
    expect(formatMicro(1_500_000n, 0)).toBe('1');
  });
});
