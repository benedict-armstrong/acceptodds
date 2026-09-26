import * as h from '@/server/api/handlers';
import { methodNotAllowed } from '@/server/api/http';

export const dynamic = 'force-dynamic';

export const GET = h.getTape;
export const POST = h.postOrder;
export const { PUT, PATCH, DELETE } = methodNotAllowed('GET', 'POST');
