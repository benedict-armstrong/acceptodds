import { describe, expect, it } from 'vitest';
import { hasSubaddress } from '@/lib/email-address';

describe('hasSubaddress', () => {
  it('spots a +tag in the local part only', () => {
    expect(hasSubaddress('ada+x@ethz.ch')).toBe(true);
    expect(hasSubaddress('+@ethz.ch')).toBe(true);
    expect(hasSubaddress('ada@ethz.ch')).toBe(false);
    expect(hasSubaddress('ada@e+thz.ch')).toBe(false);
  });
});
