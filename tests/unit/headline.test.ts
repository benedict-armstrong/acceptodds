import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  headlineOf,
  headlinePrice,
  marketHeadline,
  MIN_SQUARE_PRICE,
  openingHeadline,
  placeLabels,
  shareText,
  shareTitleLine,
  SHARE_TITLE_MAX,
  squareCounts,
  squareRow,
} from '@/lib/headline';
import { prices } from '@/lib/lmsr';

/** A price vector: 2–4 positive weights, normalised. */
const priceVector = fc
  .array(fc.double({ min: 0.001, max: 1, noNaN: true }), { minLength: 2, maxLength: 4 })
  .map((ws) => {
    const s = ws.reduce((a, b) => a + b, 0);
    return ws.map((w) => w / s);
  });

describe('headline', () => {
  it('is P(first) for a binary market and 1 − P(last) for more', () => {
    expect(headlineOf(2)).toEqual({ ordinal: 0, negated: false });
    expect(headlineOf(4)).toEqual({ ordinal: 3, negated: true });
    expect(headlinePrice([0.7, 0.3])).toBe(0.7);
    expect(headlinePrice([0.1, 0.2, 0.3, 0.4])).toBeCloseTo(0.6);
  });

  it('agrees with 1 − P(last) on binary markets too, so the convention is one rule', () => {
    fc.assert(
      fc.property(fc.double({ min: -50, max: 50, noNaN: true }), fc.double({ min: -50, max: 50, noNaN: true }), (a, b) => {
        const ps = prices([a, b], 10);
        expect(headlinePrice(ps)).toBeCloseTo(1 - ps[1], 12);
      }),
    );
  });

  it('opens at 1 − 1/n', () => {
    expect(openingHeadline(2)).toBe(0.5);
    expect(openingHeadline(4)).toBeCloseTo(0.75);
  });

  it('is 1/0 by the result once settled, null when void', () => {
    const m = (status: string, resolvedOutcomeId: string | null) => ({
      status,
      resolvedOutcomeId,
      outcomes: [0.4, 0.3, 0.2, 0.1].map((price, ordinal) => ({ id: `o${ordinal}`, ordinal, price })),
    });
    expect(marketHeadline(m('open', null))).toBeCloseTo(0.9);
    expect(marketHeadline(m('settled', 'o1'))).toBe(1);
    expect(marketHeadline(m('settled', 'o3'))).toBe(0);
    expect(marketHeadline(m('void', null))).toBeNull();
  });
});

describe('squareCounts', () => {
  it('splits ten squares by price, worst on the left in the row', () => {
    // oral, spotlight, poster, reject
    const ps = [0.1, 0.2, 0.3, 0.4];
    expect(squareCounts(ps)).toEqual([1, 2, 3, 4]);
    expect(squareRow(ps)).toBe('🟥🟥🟥🟥🟨🟨🟨🟩🟩🟦');
    expect(squareRow([0.72, 0.28])).toBe('🟥🟥🟥🟩🟩🟩🟩🟩🟩🟩');
  });

  it('always sums to the number of squares, each within one of its exact share', () => {
    fc.assert(
      fc.property(priceVector, fc.integer({ min: 1, max: 20 }), (ps, n) => {
        const counts = squareCounts(ps, n);
        expect(counts.reduce((a, b) => a + b, 0)).toBe(n);
        const eligible = ps.reduce((s, p) => (p >= MIN_SQUARE_PRICE ? s + p : s), 0);
        ps.forEach((p, i) => {
          if (p < MIN_SQUARE_PRICE) expect(counts[i]).toBe(0);
          else expect(Math.abs(counts[i] - (p / eligible) * n)).toBeLessThan(1);
        });
      }),
    );
  });

  it('gives an outcome under 5% no square', () => {
    expect(squareCounts([0.03, 0.47, 0.5])).toEqual([0, 5, 5]);
  });
});

describe('shareTitleLine', () => {
  it('keeps a short title whole', () => {
    expect(shareTitleLine('Sparse MoE', 'ICLR 2027')).toBe('Sparse MoE @ ICLR 2027?');
    expect(shareTitleLine('Sparse MoE', null)).toBe('Sparse MoE?');
  });

  it('cuts a long title at a word, and always keeps the venue', () => {
    const line = shareTitleLine(
      'On the Surprising Effectiveness of Very Long Titles: A Large-Scale Empirical Study',
      'ICLR 2027',
    );
    expect(line).toBe('On the Surprising Effectiveness of… @ ICLR 2027?');
    expect([...line].length).toBeLessThanOrEqual(SHARE_TITLE_MAX);
  });

  it('never exceeds the limit and never drops the venue', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 300 }), (title) => {
        const line = shareTitleLine(title, 'ICLR 2027');
        expect([...line].length).toBeLessThanOrEqual(SHARE_TITLE_MAX);
        expect(line.endsWith(' @ ICLR 2027?')).toBe(true);
      }),
    );
  });

  it('drops TeX dollar signs', () => {
    expect(shareTitleLine('An $O(\\sqrt{T})$ Bound', 'ICLR 2027')).toBe('An O(\\sqrt{T}) Bound @ ICLR 2027?');
  });
});

describe('placeLabels', () => {
  it('centres labels that fit', () => {
    expect(placeLabels([100, 500], [40, 60], 1000, 10)).toEqual([80, 470]);
  });

  it('keeps labels inside the bar and apart', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.double({ min: 0, max: 1000, noNaN: true }), fc.integer({ min: 10, max: 150 })), {
          minLength: 1,
          maxLength: 4,
        }),
        (items) => {
          const sorted = [...items].sort((a, b) => a[0] - b[0]);
          const widths = sorted.map(([, w]) => w);
          const left = placeLabels(sorted.map(([c]) => c), widths, 1000, 12);
          const last = left.length - 1;
          expect(left[last] + widths[last]).toBeLessThanOrEqual(1000 + 1e-9);
          if (widths.reduce((a, b) => a + b, 0) + 12 * last > 1000) return;
          expect(left[0]).toBeGreaterThanOrEqual(-1e-9);
          for (let i = 1; i < left.length; i++) {
            expect(left[i]).toBeGreaterThanOrEqual(left[i - 1] + widths[i - 1] + 12 - 1e-9);
          }
        },
      ),
    );
  });
});

describe('shareText', () => {
  const base = {
    title: 'Sparse MoE',
    kind: 'ICLR 2027',
    url: 'https://acceptodds.com/s/sparse-moe',
    status: 'open',
    prices: [0.1, 0.2, 0.3, 0.4],
    year: 2026,
  };

  it('is a BibTeX @misc with the title, the link and the bar', () => {
    expect(shareText(base)).toBe(
      [
        '@misc{sparse-moe,',
        '  title        = {Sparse MoE @ ICLR 2027?},',
        '  howpublished = {\\url{https://acceptodds.com/s/sparse-moe}},',
        '  note         = {🟥🟥🟥🟥🟨🟨🟨🟩🟩🟦},',
        '  year         = {2026}',
        '}',
      ].join('\n'),
    );
  });

  it('escapes BibTeX specials in the title', () => {
    expect(shareText({ ...base, title: 'A_b & 50% of $x$' })).toContain('title        = {A\\_b \\& 50\\% of x @ ICLR 2027?}');
  });

  it('has no bar for a settled or void market, or one with too many outcomes', () => {
    expect(shareText({ ...base, status: 'settled' })).not.toContain('note');
    expect(shareText({ ...base, status: 'void' })).not.toContain('note');
    expect(shareText({ ...base, prices: [0.2, 0.2, 0.2, 0.2, 0.2] })).not.toContain('note');
  });
});
