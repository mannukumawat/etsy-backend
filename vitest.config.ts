import { defineConfig } from 'vitest/config';

// Integration tests run against the real dev database configured by DATABASE_URL (this project has no
// separate test DB / mocking layer for Prisma) — see src/routes/__tests__/security.test.ts for how each
// test creates and tears down its own fictional accounts/orders/media so it leaves the dev data clean.
export default defineConfig({
  test: {
    environment: 'node',
    testTimeout: 20_000,
    fileParallelism: false, // shared MySQL dev DB — sequential avoids cross-test interference
  },
});
