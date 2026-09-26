import { errorResponse } from '@/server/api/http';

export const dynamic = 'force-dynamic';

/** Anything under /api/v1 that is not a route still gets the one error shape. */
function notFound(req: Request) {
  return errorResponse(404, 'not_found', `no such endpoint: ${req.method} ${new URL(req.url).pathname}`);
}

export const GET = notFound;
export const POST = notFound;
export const PUT = notFound;
export const PATCH = notFound;
export const DELETE = notFound;
