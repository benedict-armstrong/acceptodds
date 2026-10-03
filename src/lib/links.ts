/** The platform's source code, linked from the home page's abstract. */
export const REPO_URL = 'https://github.com/benedict-armstrong/acceptodds';

/** Where an account goes after its first trade (`Fill.firstTrade`): what it bought, and a link to share. */
export const FIRST_TRADE_PATH = '/first-trade';

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

/** The short share link (#11): a listing's or an unlisted market's `short_id`, which `/s/` redirects to its page. */
export function shortPath(shortId: number): string {
  return `/s/${shortId}`;
}

/**
 * Where a password-reset link lands (`app/set-password`): the address rides
 * along so the page can name the account and offer a new link.
 */
export function setPasswordPath(email: string): string {
  return `/set-password?${new URLSearchParams({ email })}`;
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
