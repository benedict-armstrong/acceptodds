import * as h from '@/server/api/handlers';
import { methodNotAllowed } from '@/server/api/http';
export const dynamic = 'force-dynamic';
export const GET = h.getListingRead;
export const PUT = h.putListingRead;
export const DELETE = h.deleteListingRead;
export const { POST, PATCH } = methodNotAllowed('GET', 'PUT', 'DELETE');
