import { describe, expect, it } from 'vitest';
import { numberAffiliations } from '@/lib/authors';

describe('numberAffiliations', () => {
  it('numbers affiliations by first appearance down the author list', () => {
    const r = numberAffiliations([
      { affiliations: ['MIT'] },
      { affiliations: [] },
      { affiliations: ['ETH Zurich', 'MIT'] },
      { affiliations: ['ETH Zurich'] },
    ]);
    expect(r.affiliations).toEqual(['MIT', 'ETH Zurich']);
    expect(r.marks).toEqual([[1], [], [2, 1], [2]]);
  });

  it('is empty for no authors', () => {
    expect(numberAffiliations([])).toEqual({ affiliations: [], marks: [] });
  });
});
