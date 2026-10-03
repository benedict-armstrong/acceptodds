import * as h from '@/server/api/handlers';
import { methodNotAllowed } from '@/server/api/http';

export const dynamic = 'force-dynamic';

export const GET = h.getListingRelated;
export const PUT = h.putListingRelated;
export const { POST, PATCH, DELETE } = methodNotAllowed('GET', 'PUT');
