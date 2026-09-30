/**
 * Where the onboarding confirmation (link or code) returns to: `/welcome`,
 * which then sees the new session and its pending bet.
 */
export const WELCOME_FINISH = '/welcome?step=finish';

/**
 * Set once `/welcome` has been shown in this browser. Until then, `/signin`
 * and `/signup` send the visitor there first; its intro links back to both.
 * A preference, not a credential: it grants nothing.
 */
export const WELCOMED_COOKIE = 'welcomed';

/** `/welcome`, keeping where sign-in or sign-up would have returned to. */
export function welcomeHref(next: string): string {
  return next === '/' ? '/welcome' : `/welcome?next=${encodeURIComponent(next)}`;
}
