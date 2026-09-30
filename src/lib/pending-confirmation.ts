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

// Writes in this tab; the `storage` event only reports other tabs'.
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

/** For `useSyncExternalStore`: every change to the pending address, in any tab. */
export function subscribePending(onChange: () => void): () => void {
  listeners.add(onChange);
  window.addEventListener('storage', onChange);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener('storage', onChange);
  };
}

/**
 * The stored record as a string, `null` once expired, so a
 * `useSyncExternalStore` snapshot compares equal while nothing changed.
 */
export function readPendingRaw(): string | null {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as { at?: unknown };
    return typeof v.at === 'number' && Date.now() - v.at <= TTL_MS ? raw : null;
  } catch {
    return null;
  }
}

export function parsePending(raw: string | null): PendingConfirmation | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { email?: unknown; next?: unknown };
    if (typeof v.email !== 'string') return null;
    return { email: v.email, next: typeof v.next === 'string' ? v.next : '/' };
  } catch {
    return null;
  }
}

/** Called each time a code is sent, which restarts its hour. */
export function rememberPending(p: PendingConfirmation): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify({ ...p, at: Date.now() }));
    notify();
  } catch {
    // No banner, then; the /confirm page still works.
  }
}

export function clearPending(): void {
  try {
    window.localStorage.removeItem(KEY);
    notify();
  } catch {
    // Nothing to clear.
  }
}
