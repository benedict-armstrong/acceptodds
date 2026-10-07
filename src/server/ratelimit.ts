import { getPool } from '@/db';
import type { Pool } from 'pg';

/**
 * Per-credential rate limiting: a token bucket, as one row in Postgres,
 * updated in the request it limits (IMPLEMENTATION.md §7). Cheaper than a
 * Redis at this scale, and the row lock makes it correct under concurrency.
 *
 * This is the **inner** layer. Anonymous traffic is limited at the edge —
 * Cloudflare, then Traefik keyed on `Cf-Connecting-Ip` (§11) — and never here.
 *
 * The bucket holds up to `burst` requests and refills at `perSecond`. The
 * clock is Postgres's (`clock_timestamp()`), not this process's, so several
 * app replicas agree on it.
 */

export interface RateLimitConfig {
  burst: number;
  perSecond: number;
}

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  /** Whole requests left in the bucket after this one. */
  remaining: number;
  /** Seconds until the bucket is full again. */
  resetSeconds: number;
  /** Seconds until one request would be allowed; 0 when `allowed`. */
  retryAfterSeconds: number;
}

/**
 * A credential's bucket. One with the `admin` scope gets its own, larger one
 * (`API_ADMIN_RATE_LIMIT_*`): `../research` bulk-writes listings and texts
 * with it, and only an operator can mint one, so the per-bot limit that keeps
 * trading fair has nothing to protect there.
 */
export function rateLimitConfig(admin = false): RateLimitConfig {
  const prefix = admin ? 'API_ADMIN_RATE_LIMIT' : 'API_RATE_LIMIT';
  const burst = Number(process.env[`${prefix}_BURST`] ?? (admin ? 600 : 60));
  const perSecond = Number(process.env[`${prefix}_PER_SECOND`] ?? (admin ? 50 : 2));
  if (!(burst >= 1) || !(perSecond > 0)) {
    throw new Error(`${prefix}_BURST must be >= 1 and ${prefix}_PER_SECOND > 0`);
  }
  return { burst, perSecond };
}

/** Take one request from `key`'s bucket, if there is one to take. */
export async function consume(
  key: string,
  config: RateLimitConfig = rateLimitConfig(),
  pool: Pool = getPool(),
): Promise<RateLimitResult> {
  const { burst, perSecond } = config;
  const client = await pool.connect();
  try {
    await client.query('begin');
    // Create the bucket full on first sight, then lock it. Two statements
    // because `on conflict do update` cannot tell us whether it refused.
    await client.query(
      `insert into rate_limit_buckets (key, tokens, updated_at)
       values ($1, $2, clock_timestamp())
       on conflict (key) do nothing`,
      [key, burst],
    );
    const { rows } = await client.query<{ tokens: number; elapsed: number }>(
      `select tokens,
              extract(epoch from clock_timestamp() - updated_at)::float8 as elapsed
         from rate_limit_buckets where key = $1 for update`,
      [key],
    );
    const refilled = Math.min(burst, rows[0].tokens + Math.max(0, rows[0].elapsed) * perSecond);
    const allowed = refilled >= 1;
    const after = allowed ? refilled - 1 : refilled;
    await client.query(`update rate_limit_buckets set tokens = $2, updated_at = clock_timestamp() where key = $1`, [
      key,
      after,
    ]);
    await client.query('commit');

    return {
      allowed,
      limit: burst,
      remaining: Math.floor(after),
      resetSeconds: Math.ceil((burst - after) / perSecond),
      retryAfterSeconds: allowed ? 0 : Math.max(1, Math.ceil((1 - after) / perSecond)),
    };
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export function rateLimitHeaders(r: RateLimitResult): Record<string, string> {
  const headers: Record<string, string> = {
    'X-RateLimit-Limit': String(r.limit),
    'X-RateLimit-Remaining': String(r.remaining),
    'X-RateLimit-Reset': String(r.resetSeconds),
  };
  if (!r.allowed) headers['Retry-After'] = String(r.retryAfterSeconds);
  return headers;
}
