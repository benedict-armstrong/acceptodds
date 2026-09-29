/**
 * Where sign-in, sign-up and email confirmation send a person back to: the
 * page they were on (issue #15). Carried as `?next=` and as Better Auth's
 * `callbackURL`, so it is attacker-chosen and must stay on this site — a
 * same-origin path, never `//host` or `/\host` (both are other hosts to a
 * browser), and never an auth page, which would loop.
 */

const AUTH_PAGES = ['/signin', '/signup', '/confirm'];

export function safeReturnTo(raw: string | string[] | null | undefined): string {
  const path = Array.isArray(raw) ? raw[0] : raw;
  if (!path || path.length > 2000) return '/';
  if (!path.startsWith('/') || path.startsWith('//') || path.startsWith('/\\')) return '/';
  // Control characters and whitespace (a tab or newline can turn `/\t/host` into `//host`).
  if (/[\u0000- \u007f\\]/.test(path)) return '/';
  const pathname = path.split(/[?#]/, 1)[0];
  if (AUTH_PAGES.some((p) => pathname === p || pathname.startsWith(`${p}/`))) return '/';
  return path;
}

/** `/signin`, `/signup` or `/confirm`, returning to `returnTo` afterwards. */
export function authHref(page: '/signin' | '/signup' | '/confirm', returnTo: string, extra: Record<string, string> = {}): string {
  const params = new URLSearchParams(extra);
  const next = safeReturnTo(returnTo);
  if (next !== '/') params.set('next', next);
  const qs = params.toString();
  return qs ? `${page}?${qs}` : page;
}
