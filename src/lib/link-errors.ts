/**
 * Why a link from one of our mails did not work, for `/signin?error=`,
 * where every broken confirmation or sign-in link ends up. The codes are
 * Better Auth's (`INVALID_TOKEN`, `TOKEN_EXPIRED`, …), which it appends to
 * the link's return address, plus `LINK_USED` for a link opened a second
 * time, which Better Auth sends back with no error and no session. Each
 * points at the way out on that page: the password, or a sign-in link,
 * which works for every account.
 */

export const LINK_USED = 'LINK_USED';

const MESSAGES: Record<string, string> = {
  INVALID_TOKEN:
    'That link no longer works: it was already used, cut off, or replaced by a newer mail. Sign in, or email yourself a sign-in link below.',
  TOKEN_EXPIRED: 'That link has expired. Sign in, or email yourself a new sign-in link below.',
  EXPIRED_TOKEN: 'That link has expired. Sign in, or email yourself a new sign-in link below.',
  USER_NOT_FOUND: 'That link is for an address with no account. Sign up again for a new one.',
  [LINK_USED]:
    'That link was already used, so your address is confirmed. Sign in, or email yourself a sign-in link below.',
  EMAIL_DOMAIN_NOT_ALLOWED: 'That address is not at an institution on our list.',
};

/** What to tell the person, or `null` when there is no error. Unknown codes get a general message, never the code. */
export function linkErrorMessage(code: string | string[] | undefined): string | null {
  const c = Array.isArray(code) ? code[0] : code;
  if (!c) return null;
  return MESSAGES[c] ?? 'That link did not work. Sign in, or email yourself a sign-in link below.';
}
