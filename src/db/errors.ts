/**
 * Postgres error codes, read through Drizzle's wrapping.
 *
 * Drizzle wraps a failed query in a `DrizzleQueryError` whose `cause` is the
 * `pg` error carrying the SQLSTATE; `err.code` on the wrapper is undefined. A
 * check that only looks at the top level silently never matches — which is
 * how the engine's idempotency race once surfaced as a 500 instead of the
 * original fill.
 */
export function pgErrorCode(err: unknown): string | undefined {
  for (let e: unknown = err, depth = 0; e && typeof e === 'object' && depth < 5; depth += 1) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
}

/** SQLSTATE 23505. */
export function isUniqueViolation(err: unknown): boolean {
  return pgErrorCode(err) === '23505';
}
