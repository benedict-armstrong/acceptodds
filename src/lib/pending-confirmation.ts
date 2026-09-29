/**
 * The address a person signed up with and has not confirmed yet, remembered
 * in this browser only so the "confirm your email" banner can follow them
 * around the site while they wait for the mail (issue #15). A convenience,
 * nothing more: it grants nothing, the server never reads it, and it is gone
 * after the hour the code is valid for. Storage can throw (private windows,
 * blocked site data), so every access is guarded and a failure means no
 * banner.
 */

const KEY = 'pending_confirmation';
const TTL_MS = 60 * 60 * 1000;

export interface PendingConfirmation {
  email: string;
  next: string;
}

export function readPending(): PendingConfirmation | null {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as { email?: unknown; next?: unknown; at?: unknown };
    if (typeof v.email !== 'string' || typeof v.at !== 'number' || Date.now() - v.at > TTL_MS) {
      window.localStorage.removeItem(KEY);
      return null;
    }
    return { email: v.email, next: typeof v.next === 'string' ? v.next : '/' };
  } catch {
    return null;
  }
}

/** Called each time a code is sent, which restarts its hour. */
export function rememberPending(p: PendingConfirmation): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify({ ...p, at: Date.now() }));
  } catch {
    // No banner, then; the /confirm page still works.
  }
}

export function clearPending(): void {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    // Nothing to clear.
  }
}
