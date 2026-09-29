import { describe, expect, it } from 'vitest';
import { ACCEPT_AT, likelihood, likelihoodClass, marketLikelihood, REJECT_AT } from '@/lib/likelihood';

const binary = (p: number, extra: Partial<{ status: string; resolvedOutcomeId: string | null }> = {}) => ({
  status: 'open',
  resolvedOutcomeId: null,
  ...extra,
  outcomes: [
    { id: 'yes', ordinal: 0, price: p },
    { id: 'no', ordinal: 1, price: 1 - p },
  ],
});

describe('likelihood', () => {
  it('splits at the thresholds, inclusively', () => {
    expect(likelihood(ACCEPT_AT)).toBe('accept');
    expect(likelihood(0.99)).toBe('accept');
    expect(likelihood(REJECT_AT)).toBe('reject');
    expect(likelihood(0.01)).toBe('reject');
    expect(likelihood(0.5)).toBe('toss-up');
    expect(likelihood(ACCEPT_AT - 1e-9)).toBe('toss-up');
    expect(likelihood(REJECT_AT + 1e-9)).toBe('toss-up');
  });

  it('reads a binary market’s first outcome, whatever order the outcomes arrive in', () => {
    expect(marketLikelihood(binary(0.8))).toBe('accept');
    expect(marketLikelihood(binary(0.2))).toBe('reject');
    const m = binary(0.8);
    m.outcomes.reverse();
    expect(marketLikelihood(m)).toBe('accept');
  });

  it('uses the result once settled, and nothing for void or multi-outcome markets', () => {
    expect(marketLikelihood(binary(0.2, { status: 'settled', resolvedOutcomeId: 'yes' }))).toBe('accept');
    expect(marketLikelihood(binary(0.9, { status: 'settled', resolvedOutcomeId: 'no' }))).toBe('reject');
    expect(marketLikelihood(binary(0.9, { status: 'void' }))).toBeNull();
    expect(
      marketLikelihood({
        status: 'open',
        resolvedOutcomeId: null,
        outcomes: [0.8, 0.1, 0.1].map((price, ordinal) => ({ id: `o${ordinal}`, ordinal, price })),
      }),
    ).toBeNull();
  });

  it('maps to token classes, and to a neutral look for no likelihood', () => {
    expect(likelihoodClass('accept').text).toBe('text-accept');
    expect(likelihoodClass('reject').bar).toBe('bg-reject');
    expect(likelihoodClass(null).text).toBe('text-ink');
  });
});
