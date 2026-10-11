// Gate run of test-gates itself. The list of gates lives in test-gates.json.
// istanbul: on Vitest 3 the v8 provider does not count the skipped side of an `if` without `else`.
import { defineConfig } from 'vitest/config';
import { createVitestGatesConfig } from './src/vitest';

export default defineConfig(
  createVitestGatesConfig({ rootDir: import.meta.url, coverageProvider: 'istanbul' })
);
