import { describe, expect, it } from 'vitest';
import { LINK_USED, linkErrorMessage } from '@/lib/link-errors';

describe('linkErrorMessage', () => {
  it("explains Better Auth's codes and a used link", () => {
    expect(linkErrorMessage('TOKEN_EXPIRED')).toContain('expired');
    expect(linkErrorMessage('INVALID_TOKEN')).toContain('not valid');
    expect(linkErrorMessage(LINK_USED)).toContain('already used');
  });

  it('is null without an error, and never echoes an unknown code', () => {
    expect(linkErrorMessage(undefined)).toBeNull();
    expect(linkErrorMessage('')).toBeNull();
    expect(linkErrorMessage('<script>')).not.toContain('<script>');
  });
});
