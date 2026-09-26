import 'dotenv/config';

/**
 * Integration tests must never touch the dev database: they truncate every
 * table. Point the whole process at `TEST_DATABASE_URL` before anything
 * imports `@/db` and opens a pool.
 */
if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
}

// Better Auth, for the auth tests. The origin matches the in-process test client.
process.env.BETTER_AUTH_URL = 'http://test.local';
process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret-0000';
