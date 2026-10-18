import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// Integration tests: each run gets its own disposable PostgreSQL database.
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    include: ['test/integration/**/*.int-spec.ts'],
    environment: 'node',
    globalSetup: ['test/support/integration-global-setup.ts'],
    setupFiles: ['test/support/no-ambient-database.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
