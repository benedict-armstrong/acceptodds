import { getAuth } from '@/server/better-auth';

export const dynamic = 'force-dynamic';

/**
 * Better Auth's own endpoints: sign-up, sign-in (email + password, ORCID),
 * email verification, sessions, sign-out. Resolved lazily so that `next build`
 * needs neither a database nor a secret.
 */
function handle(req: Request): Promise<Response> {
  return getAuth().handler(req);
}

export const GET = handle;
export const POST = handle;
