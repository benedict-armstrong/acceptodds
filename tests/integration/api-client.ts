/* eslint-disable @typescript-eslint/no-explicit-any -- response bodies are checked field by field */
import type { TokenScope } from '@/db/schema';
import { createAccount } from '@/server/accounts';
import { mintToken } from '@/server/tokens';
import * as marketsRoute from '@/app/api/v1/markets/route';
import * as marketRoute from '@/app/api/v1/markets/[id]/route';
import * as historyRoute from '@/app/api/v1/markets/[id]/history/route';
import * as ordersRoute from '@/app/api/v1/markets/[id]/orders/route';
import * as quoteRoute from '@/app/api/v1/markets/[id]/quote/route';
import * as closeRoute from '@/app/api/v1/markets/[id]/close/route';
import * as settleRoute from '@/app/api/v1/markets/[id]/settle/route';
import * as leaderboardRoute from '@/app/api/v1/leaderboard/route';
import * as accountRoute from '@/app/api/v1/accounts/[handle]/route';
import * as meRoute from '@/app/api/v1/me/route';
import * as portfolioRoute from '@/app/api/v1/me/portfolio/route';
import * as myOrdersRoute from '@/app/api/v1/me/orders/route';
import * as tokensRoute from '@/app/api/v1/me/tokens/route';
import * as openapiRoute from '@/app/api/v1/openapi.json/route';
import * as fallbackRoute from '@/app/api/v1/[...rest]/route';
import { STARTING_MICRO } from './helpers';

/**
 * Calls the real route modules under `src/app/api/v1` with real `Request`
 * objects and returns real `Response`s — the same objects Next hands them —
 * without starting a server. The route table mirrors the file system.
 */

type Mod = Record<string, unknown>;

const ROUTES: [pattern: string, mod: Mod][] = [
  ['/openapi.json', openapiRoute],
  ['/markets', marketsRoute],
  ['/markets/[id]', marketRoute],
  ['/markets/[id]/history', historyRoute],
  ['/markets/[id]/orders', ordersRoute],
  ['/markets/[id]/quote', quoteRoute],
  ['/markets/[id]/close', closeRoute],
  ['/markets/[id]/settle', settleRoute],
  ['/leaderboard', leaderboardRoute],
  ['/accounts/[handle]', accountRoute],
  ['/me', meRoute],
  ['/me/portfolio', portfolioRoute],
  ['/me/orders', myOrdersRoute],
  ['/me/tokens', tokensRoute],
];

export const ROUTE_PATTERNS = ROUTES.map(([p]) => p);

function match(path: string): { mod: Mod; params: Record<string, string> } {
  const segments = path.split('/').filter(Boolean);
  for (const [pattern, mod] of ROUTES) {
    const parts = pattern.split('/').filter(Boolean);
    if (parts.length !== segments.length) continue;
    const params: Record<string, string> = {};
    const ok = parts.every((p, i) => {
      const m = /^\[(\w+)\]$/.exec(p);
      if (m) {
        params[m[1]] = decodeURIComponent(segments[i]);
        return true;
      }
      return p === segments[i];
    });
    if (ok) return { mod, params };
  }
  return { mod: fallbackRoute, params: { rest: segments.join('/') } };
}

export interface ApiResult<T = any> {
  status: number;
  headers: Headers;
  body: T;
}

export async function api<T = any>(
  method: string,
  pathAndQuery: string,
  opts: { token?: string; body?: unknown; headers?: Record<string, string>; rawBody?: string } = {},
): Promise<ApiResult<T>> {
  const url = new URL(`/api/v1${pathAndQuery}`, 'http://test.local');
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  let body: string | undefined = opts.rawBody;
  if (opts.body !== undefined) {
    body = JSON.stringify(opts.body);
    headers['content-type'] = 'application/json';
  }
  const req = new Request(url, { method, headers, body });

  const { mod, params } = match(url.pathname.replace(/^\/api\/v1/, ''));
  const handler = mod[method] as
    | ((req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response> | Response)
    | undefined;
  if (!handler) throw new Error(`no ${method} export for ${url.pathname}`);
  const res = await handler(req, { params: Promise.resolve(params) });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
}

/** A funded trader with a token. */
export async function trader(
  handle: string,
  scopes: TokenScope[] = ['read', 'trade'],
  opts: { isBot?: boolean; grantMicro?: bigint } = {},
): Promise<{ id: string; token: string; tokenId: string }> {
  const account = await createAccount({
    handle,
    displayName: handle,
    isBot: opts.isBot ?? false,
    grantMicro: opts.grantMicro ?? STARTING_MICRO,
  });
  const { token, row } = await mintToken({ accountId: account.id, name: `${handle} test`, scopes });
  return { id: account.id, token, tokenId: row.id };
}
