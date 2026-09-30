import * as h from '@/server/api/handlers';
import { methodNotAllowed } from '@/server/api/http';

export const dynamic = 'force-dynamic';

export const DELETE = h.deleteMyAffiliation;
export const { GET, POST, PUT, PATCH } = methodNotAllowed('DELETE');
