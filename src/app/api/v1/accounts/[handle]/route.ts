import * as h from '@/server/api/handlers';
import { methodNotAllowed } from '@/server/api/http';

export const dynamic = 'force-dynamic';

export const GET = h.getAccount;
export const { POST, PUT, PATCH, DELETE } = methodNotAllowed('GET');
