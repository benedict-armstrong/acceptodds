import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { coarseStakeMicro, STAKE_DIGITS } from '@/lib/stake';

describe('coarseStakeMicro', () => {
  it('rounds down to two significant figures', () => {
    expect(coarseStakeMicro(254_312_877n)).toBe(250_000_000n);
    expect(coarseStakeMicro(8_734_000n)).toBe(8_700_000n);
    expect(coarseStakeMicro(43_800n)).toBe(43_000n);
    expect(coarseStakeMicro(7n)).toBe(7n);
    expect(coarseStakeMicro(0n)).toBe(0n);
  });

  it('is positive, never more than held, and keeps at most two significant figures', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 1n, max: 10n ** 18n }), (held) => {
        const shown = coarseStakeMicro(held);
        expect(shown > 0n).toBe(true);
        expect(shown <= held).toBe(true);
        expect(shown.toString().replace(/0+$/, '').length <= STAKE_DIGITS).toBe(true);
      }),
    );
  });
});
