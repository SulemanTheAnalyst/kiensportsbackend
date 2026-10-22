import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globals: false,
    // The integration suites share one test database and create real
    // products/orders. Running test files in parallel makes exact-count
    // catalog assertions racy, so execute files sequentially.
    fileParallelism: false,
  },
});
