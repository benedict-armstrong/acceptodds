/**
 * A group invite a signed-out visitor chose to accept, remembered in this
 * browser so they join once they have signed in or signed up
 * (`components/PendingGroupJoin`), wherever onboarding leaves them. Set only
 * by pressing the invite page's button, never by opening a link, so
 * following a link still joins nothing by itself. It grants nothing: the
 * join is the usual `POST /groups/join` with the code. A day, then gone.
 * Storage can throw (private windows, blocked site data), so every access
 * is guarded and a failure means the invite page's own button instead.
 */

const KEY = 'pending_group_invite';
const TTL_MS = 24 * 60 * 60 * 1000;

export function rememberInvite(code: string): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify({ code, at: Date.now() }));
  } catch {
    // They join from the invite page after signing in, then.
  }
}

/** The remembered invite code, `null` when there is none or it has expired. */
export function readInvite(): string | null {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as { code?: unknown; at?: unknown };
    if (typeof v.code !== 'string' || typeof v.at !== 'number' || Date.now() - v.at > TTL_MS) return null;
    return v.code;
  } catch {
    return null;
  }
}

export function clearInvite(): void {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    // Nothing to clear.
  }
}
