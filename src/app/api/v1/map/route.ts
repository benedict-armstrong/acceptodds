import * as h from '@/server/api/handlers';
import { methodNotAllowed } from '@/server/api/http';

export const dynamic = 'force-dynamic';

export const GET = h.getMap;
export const PUT = h.putMap;
export const { POST, PATCH, DELETE } = methodNotAllowed('GET', 'PUT');
