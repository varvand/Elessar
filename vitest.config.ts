import { defineConfig } from 'vitest/config';

/**
 * One root config for the whole workspace, so `pnpm test` from anywhere runs the
 * entire suite. Deliberately not per-package projects: an agent (or a human)
 * should never have to know which package a change touched in order to validate
 * it, and the suite is fast enough that running all of it is always the right
 * default.
 *
 * Hard constraint: **every test here runs offline, with no database and no
 * embedding model.** That is what makes the suite usable as a gate — it runs in
 * seconds anywhere, including a fresh clone with no `.env`, no Docker and no
 * seeded gazetteer. Tests needing real infrastructure would silently skip in
 * exactly the environments where they matter most, so instead the pieces that
 * touch I/O are tested against fixtures.
 */
export default defineConfig({
  test: {
    include: ['{apps,packages}/**/src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/.next/**', '**/dist/**'],
    environment: 'node',

    // A test that hangs is a broken gate. Nothing here is slow enough to need
    // more than this, and the low ceiling catches accidental network calls.
    testTimeout: 10_000,
    hookTimeout: 10_000,

    // Config lives here, not in .env, so the suite is independent of local setup.
    env: {
      NODE_ENV: 'test',
      ELESSAR_SKIP_DOTENV: '1',
      ELESSAR_LOG_LEVEL: 'error',
      DATABASE_URL: 'postgres://test:test@localhost:5433/test_unused',
      ELESSAR_USER_AGENT: 'Elessar-Test/0.1',
    },

    reporters: process.env.CI ? ['default', 'github-actions'] : ['default'],

    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'html'],
      include: ['packages/*/src/**/*.ts', 'apps/*/src/**/*.ts'],
      exclude: [
        '**/*.test.ts',
        '**/__tests__/**',
        // Thin I/O shells: exercised by `pnpm probe` against live upstreams,
        // where a fixture would only prove the fixture still parses.
        '**/scripts/**',
        'packages/db/src/migrate.ts',
        'packages/core/src/logger.ts',
      ],
    },
  },
});
