import { defineConfig } from 'vitest/config';
import { HEAVY_TESTS } from './vitest.config';

// The tests `npm test` leaves out: see vitest.config.ts.
export default defineConfig({
  test: {
    environment: 'node',
    include: HEAVY_TESTS,
    testTimeout: 30_000,
  },
});
