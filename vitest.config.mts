import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  // tsconfig says `jsx: preserve` for Next; tests that import a .tsx module
  // (the link-preview image) need it compiled.
  oxc: { jsx: { runtime: 'automatic' } },
  test: {
    environment: 'node',
    setupFiles: ['./tests/setup-env.ts'],
    include: ['tests/**/*.test.ts'],
    // Integration tests share one Postgres database and truncate between
    // files, so they must not run in parallel with each other.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
