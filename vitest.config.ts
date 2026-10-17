import { defineConfig } from 'vitest/config';

// Tests that start a real Stryker, Jest or Vitest, or a process for every case. They take about
// two minutes together and run with `npm run test:heavy`, which CI always does.
export const HEAVY_TESTS = [
  'test/affected-reuse.test.ts',
  'test/incremental-reuse.test.ts',
  'test/incremental-stale.test.ts',
  'test/retry-timeouts.test.ts',
  'test/reuse-guard.test.ts',
  'test/selfcheck-runners-jest.test.ts',
  'test/selfcheck-runners-other.test.ts',
  'test/selfcheck-runners-vitest-threads.test.ts',
  'test/selfcheck-runners-vitest.test.ts',
  'test/stale-sandboxes.test.ts',
];

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**', ...HEAVY_TESTS],
    testTimeout: 30_000,
    coverage: {
      provider: 'v8',
      reporter: ['text'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/cli.ts', 'src/index.ts', 'src/core/types.ts'],
    },
  },
});
