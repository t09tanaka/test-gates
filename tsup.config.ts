import { defineConfig } from 'tsup';

export default defineConfig([
  {
    // Library entries: dual output so that a CommonJS jest config can `require` the helpers.
    // The reporter is loaded by Jest itself, by path (see src/touch.ts).
    entry: [
      'src/index.ts',
      'src/jest.ts',
      'src/vitest.ts',
      'src/stryker.ts',
      'src/jest-touch-reporter.ts',
    ],
    format: ['esm', 'cjs'],
    // import.meta.url in the CommonJS output
    shims: true,
    dts: true,
    clean: true,
    target: 'node20',
  },
  {
    entry: ['src/cli.ts'],
    format: ['esm'],
    dts: false,
    clean: false,
    target: 'node20',
  },
]);
