// Mutation test of test-gates itself. Uses the built helper, so run `npm run build` first.
import { createStrykerGatesConfig } from './dist/stryker.js';

export default createStrykerGatesConfig({
  rootDir: import.meta.url,
  testRunner: 'vitest',
  vitest: { configFile: 'vitest.gates.config.ts' },
  concurrency: 2,
  ignorePatterns: ['coverage', 'reports'],
});
