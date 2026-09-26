/**
 * Entry point for the Better Auth CLI only (`npm run auth:generate`), which
 * needs a module exporting `auth`. The app uses `getAuth()` instead.
 */
import { createDb, createPool } from '@/db';
import { createAuth } from '@/server/better-auth';

export const auth = createAuth(createDb(createPool(process.env.DATABASE_URL ?? 'postgres://localhost/unused')));
