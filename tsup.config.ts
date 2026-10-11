import { defineConfig } from 'tsup';

export default defineConfig([
  {
    // Library entries: dual output so that a CommonJS jest config can `require` the helpers.
    entry: ['src/index.ts', 'src/jest.ts', 'src/vitest.ts', 'src/stryker.ts'],
    format: ['esm', 'cjs'],
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
