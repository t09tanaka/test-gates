import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { cleanup, project, repoRoot, testGatesAsync, write } from './helpers';
import { gate, helper, strykerRuns } from './support/incremental';

afterAll(cleanup);

// The false pass the guard is there for: Stryker does not notice a change in a file that a
// spec imports, and would reuse the "Killed" of mutants that now survive.
describe.skipIf(!strykerRuns).each(['vitest', 'jest'] as const)(
  'test-gates mutation after a change that Stryker does not see (%s)',
  (runner) => {
    const NOTE =
      'test-gates mutation: running every mutant again (--force), the results of the last run are not reused: ';
    const ext = runner === 'vitest' ? 'ts' : 'js';
    const sources: {
      gate: (shift: string) => string;
      helper: (assertion: string) => string;
      specHead: string;
      config: Record<string, string>;
      stryker: string;
    } =
      runner === 'vitest'
        ? {
            gate: (shift: string) =>
              `const since = (days: number) => days${shift};\n` +
              "export const canRefund = (state: string, days: number) => state === 'paid' && since(days) <= 14;\n",
            helper: (assertion: string) =>
              "import { expect } from 'vitest';\n" +
              `export const expectTrue = (actual: boolean) => expect(actual).${assertion};\n`,
            specHead:
              "import { expect, it } from 'vitest';\nimport { expectTrue } from './expect-true';\nimport { canRefund } from './refund';\n",
            config: {
              'vitest.gates.config.ts':
                `import { createVitestGatesConfig } from ${JSON.stringify(helper('vitest'))};\n` +
                'export default createVitestGatesConfig({ rootDir: import.meta.url });\n',
            },
            stryker: "testRunner: 'vitest', vitest: { configFile: 'vitest.gates.config.ts' }",
          }
        : {
            gate: (shift: string) =>
              `const since = (days) => days${shift};\n` +
              "exports.canRefund = (state, days) => state === 'paid' && since(days) <= 14;\n",
            helper: (assertion: string) =>
              `exports.expectTrue = (actual) => expect(actual).${assertion};\n`,
            specHead:
              "const { expectTrue } = require('./expect-true');\nconst { canRefund } = require('./refund');\n",
            config: {
              'jest.gates.config.js':
                `const { createJestGatesConfig } = require(${JSON.stringify(path.join(repoRoot, 'dist', 'jest.cjs'))});\n` +
                'module.exports = createJestGatesConfig({ rootDir: __dirname });\n',
            },
            stryker:
              "testRunner: 'jest', jest: { projectType: 'custom', configFile: 'jest.gates.config.js' }",
          };
    const SPEC =
      sources.specHead +
      "it('refunds a paid order up to day 14', () => { expectTrue(canRefund('paid', 14)); });\n" +
      "it('does not refund later, or an open order', () => {\n" +
      "  expect(canRefund('paid', 15)).toBe(false);\n" +
      "  expect(canRefund('open', 1)).toBe(false);\n" +
      '});\n';

    it(
      'runs every mutant again and finds the survivors, also after a change of only the gate',
      { timeout: 480_000 },
      async () => {
        const dir = project({
          'package.json': {
            name: 'guard-fixture',
            private: true,
            ...(runner === 'vitest' ? { type: 'module' } : {}),
          },
          'test-gates.json': { gates: [gate(`src/refund.${ext}`)], candidates: [] },
          [`src/refund.${ext}`]: sources.gate(''),
          [`src/refund.spec.${ext}`]: SPEC,
          [`src/expect-true.${ext}`]: sources.helper('toBe(true)'),
          ...sources.config,
          'stryker.gates.config.mjs':
            `import { createStrykerGatesConfig } from ${JSON.stringify(helper('stryker'))};\n` +
            `export default createStrykerGatesConfig({ rootDir: import.meta.url, ${sources.stryker}, concurrency: 1 });\n`,
        });
        fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
        const run = (...args: string[]) => testGatesAsync(['mutation', '--dir', dir, ...args]);
        const reused = (stdout: string) => {
          const match = /(\d+) of (\d+) mutant result\(s\) are reused/.exec(stdout);
          return match === null ? null : [Number(match[1]), Number(match[2])];
        };

        // 1. The first run passes: every mutant is killed.
        const first = await run();
        expect(first.stdout).not.toContain(NOTE);
        expect(first.stdout).toContain('unallowed survivors 0)');
        expect(first.status).toBe(0);

        // 2. Nothing changed: every result is reused.
        const second = await run();
        expect(second.stdout).not.toContain(NOTE);
        const [reusedCount, total] = reused(second.stdout) as number[];
        expect(reusedCount).toBe(total);
        expect(second.status).toBe(0);

        // 3. The assertion is weakened in the file the spec imports. Neither the gate nor the
        //    spec changed, so Stryker alone would reuse every "Killed" and the run would pass.
        write(dir, { [`src/expect-true.${ext}`]: sources.helper('toBeDefined()') });
        const weakened = await run();
        expect(weakened.stdout).toContain(
          `${NOTE}changed since the last run: src/expect-true.${ext}`
        );
        expect(reused(weakened.stdout)).toEqual([0, total]);
        expect(weakened.stderr).toMatch(
          /test-gates mutation: \d+ surviving mutant\(s\) not in the allow list/
        );
        expect(weakened.stderr).toContain(`  - src/refund.${ext}:2:`);
        expect(weakened.status).toBe(1);

        // 4. Run again without a change: the survivors are still reported, from the reused results.
        const again = await run();
        expect(again.stdout).not.toContain(NOTE);
        expect(reused(again.stdout)).toEqual([total, total]);
        expect(again.status).toBe(1);

        // 5. The assertion is put back: every mutant is run again and killed.
        write(dir, { [`src/expect-true.${ext}`]: sources.helper('toBe(true)') });
        const restored = await run();
        expect(restored.stdout).toContain(NOTE);
        expect(restored.status).toBe(0);

        // 6. Only the gate changes, on another line than the comparison: a day now counts from
        //    half a day earlier. The tests still pass, but `<= 14` can no longer be told from
        //    `< 14`. Stryker alone reuses the old "Killed" of that mutant, its text being the same.
        write(dir, { [`src/refund.${ext}`]: sources.gate(' - 0.5') });
        const shifted = await run();
        expect(shifted.stdout).toContain(`${NOTE}changed since the last run: src/refund.${ext}`);
        expect(shifted.stderr).toContain(`  - src/refund.${ext}:2:`);
        expect(shifted.stderr).toContain('since(days) <= 14 → since(days) < 14 (Survived)');
        expect(shifted.status).toBe(1);

        // 7. Only the spec changes: a full run as well.
        write(dir, {
          [`src/refund.${ext}`]: sources.gate(''),
          [`src/refund.spec.${ext}`]: `${SPEC}// reviewed\n`,
        });
        const specOnly = await run();
        expect(specOnly.stdout).toContain(NOTE);
        expect(reused(specOnly.stdout)).toEqual([0, total]);
        expect(specOnly.status).toBe(0);
      }
    );
  }
);
