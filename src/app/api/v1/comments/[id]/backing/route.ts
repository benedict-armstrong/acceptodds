import * as h from '@/server/api/handlers';
import { methodNotAllowed } from '@/server/api/http';

export const dynamic = 'force-dynamic';

export const POST = h.postCommentBacking;
export const DELETE = h.deleteCommentBacking;
export const { GET, PUT, PATCH } = methodNotAllowed('POST', 'DELETE');
