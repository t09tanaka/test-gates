import os from 'node:os';
import { defineConfig } from 'vitest/config';
import { HEAVY_TESTS } from './vitest.config';

// Each heavy test runs a real Stryker, Jest or Vitest (and `selfcheck --jobs` runs several),
// so the files at once multiply. On 12 cores all 8 at once took 166 s at a peak load of 153; 4
// took 160-167 s at 55-71 (3: 193 s, 2: 269 s). In CI Vitest's own default (cores - 1) is lower.
const workers = Math.min(4, Math.max(1, os.availableParallelism() - 1));

// The tests `npm test` leaves out: see vitest.config.ts.
export default defineConfig({
  test: {
    environment: 'node',
    include: HEAVY_TESTS,
    testTimeout: 30_000,
    maxWorkers: workers,
    minWorkers: workers,
  },
});
