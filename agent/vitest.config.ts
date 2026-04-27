import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Run tests in-process with tsx transpilation
    // This matches the project's tsx-based runtime
    globals: false,
    environment: 'node',
    testTimeout: 30000,
    hookTimeout: 30000,
    // Retry flaky tests once (for real SDK integration tests)
    retry: 0,
    // Print individual test results
    verbose: true,
  },
  esbuild: {
    target: 'es2022',
  },
});
