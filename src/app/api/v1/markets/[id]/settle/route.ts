import * as h from '@/server/api/handlers';
import { methodNotAllowed } from '@/server/api/http';

export const dynamic = 'force-dynamic';

export const POST = h.postSettle;
export const { GET, PUT, PATCH, DELETE } = methodNotAllowed('POST');
