import * as h from '@/server/api/handlers';
import { methodNotAllowed } from '@/server/api/http';

export const dynamic = 'force-dynamic';

export const DELETE = h.deleteMyPendingBet;
export const { GET, POST, PATCH, PUT } = methodNotAllowed('DELETE');
