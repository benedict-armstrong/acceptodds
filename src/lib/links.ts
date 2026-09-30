/**
 * Where a market is read: its paper's page with the market selected, or the
 * market's own page when it has no listing. Plain, so Server and Client
 * Components can both call it.
 */
export function marketHref(m: { marketSlug: string; listingSlug: string | null }): string {
  return m.listingSlug
    ? `/papers/${m.listingSlug}?market=${encodeURIComponent(m.marketSlug)}`
    : `/markets/${m.marketSlug}`;
}

/**
 * Where a password-reset link lands (`app/set-password`): the address rides
 * along so the page can sign in once the password is set. With `code`, the
 * page sets it with that code from the mail instead of the link's token.
 */
export function setPasswordPath(email: string, code?: string): string {
  const q = new URLSearchParams({ email });
  if (code) q.set('code', code);
  return `/set-password?${q}`;
}

/**
 * Where every sign-in link lands (`app/signin/continue`), new account or
 * not, and where a dead one reports its error: that page asks for whatever
 * is missing (a name, a password), then goes on to `next`.
 */
export function signInContinueHref(next: string): string {
  return next === '/' ? '/signin/continue' : `/signin/continue?next=${encodeURIComponent(next)}`;
}

/** A public position's page (#36): the link its holder shares. */
export function publicPositionPath(id: string): string {
  return `/positions/${id}`;
}

/** A group's board (#25): the leaderboard ranked among its members. */
export function groupPath(id: string): string {
  return `/leaderboard?group=${id}`;
}

/** An institution's board: the leaderboard ranked among the traders confirmed there. */
export function institutionPath(name: string): string {
  return `/leaderboard?institution=${encodeURIComponent(name)}`;
}

/**
 * A group's invite link. The code rides in the query, which page analytics
 * never records (`lib/analytics.ts`), so it stays with whoever it was sent to.
 */
export function groupInvitePath(code: string): string {
  return `/groups/join?code=${encodeURIComponent(code)}`;
}
