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
 * along so the page can sign in once the password is set.
 */
export function setPasswordPath(email: string): string {
  return `/set-password?email=${encodeURIComponent(email)}`;
}
