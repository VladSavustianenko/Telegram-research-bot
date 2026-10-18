import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// Unit tests: no database, no network. Fakes only.
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    include: ['src/**/*.spec.ts', 'test/support/**/*.spec.ts'],
    environment: 'node',
    setupFiles: ['test/support/no-ambient-database.ts'],
    restoreMocks: true,
  },
});
