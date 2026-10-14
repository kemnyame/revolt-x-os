import { defineConfig } from 'vitest/config';

// Embedded PostgreSQL fixtures and real password hashing share CI resources.
// Bound their concurrency so authentication tests are reliable on small runners.
export default defineConfig({
  test: { maxWorkers: 2, testTimeout: 30_000, hookTimeout: 30_000 }
});
