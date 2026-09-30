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
