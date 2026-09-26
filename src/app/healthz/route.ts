import { NextResponse } from 'next/server';
import { checkDatabase } from '@/db';

export const dynamic = 'force-dynamic';

/**
 * Liveness AND readiness. It touches the database on purpose: a container that
 * is up with a dead connection pool is the failure you actually get, and a 200
 * that never reached Postgres would hide it from the uptime monitor.
 */
export async function GET() {
  try {
    await checkDatabase();
  } catch {
    return NextResponse.json(
      { status: 'error', database: 'unreachable' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  return NextResponse.json(
    { status: 'ok' },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
