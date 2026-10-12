import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { cleanup, project, repoRoot, testGatesAsync, write } from './helpers';

afterAll(cleanup);

// A real Stryker run. Stryker 10 does not start below Node.js 22.12.
const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
const strykerRuns = major > 22 || (major === 22 && minor >= 12);

const helper = (name: string) => pathToFileURL(path.join(repoRoot, 'dist', `${name}.js`)).href;
const gate = (file: string) => ({ path: file, decides: 'd', impact: 'i' });
const SPEC_HEAD = "import { expect, it } from 'vitest';\nimport { has } from './kinds';\n";
const KNOWS_A =
  "it('knows a', () => { expect(has('a')).toBe(true); expect(has('z')).toBe(false); });\n";
const KNOWS_B =
  "it('knows b', () => { expect(has('b')).toBe(true); expect(has('')).toBe(false); });\n";

function report(dir: string, file: string): Record<string, { status: string }[]> {
  const parsed = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) as {
    files: Record<string, { mutants: { status: string }[] }>;
  };
  return Object.fromEntries(
    Object.entries(parsed.files).map(([name, value]) => [name, value.mutants])
  );
}

describe.skipIf(!strykerRuns)('test-gates mutation with the Stryker incremental file', () => {
  it(
    'judges a fully reused run, shows the stale static survivor, and ignores a removed gate',
    { timeout: 240_000 },
    async () => {
      const dir = project({
        'package.json': { name: 'incremental-fixture', private: true, type: 'module' },
        'test-gates.json': { gates: [gate('src/kinds.ts'), gate('src/age.ts')], candidates: [] },
        // `KINDS` is evaluated when the module loads: its mutants are static.
        'src/kinds.ts':
          "const KINDS = ['a', 'b'];\nexport const has = (kind: string) => KINDS.includes(kind);\n",
        'src/kinds.spec.ts': SPEC_HEAD + KNOWS_A,
        'src/age.ts': 'export const isAdult = (age: number) => age >= 18;\n',
        'src/age.spec.ts':
          "import { expect, it } from 'vitest';\nimport { isAdult } from './age';\n" +
          "it('is adult from 18', () => { expect(isAdult(18)).toBe(true); expect(isAdult(17)).toBe(false); });\n",
        'vitest.gates.config.ts':
          `import { createVitestGatesConfig } from ${JSON.stringify(helper('vitest'))};\n` +
          'export default createVitestGatesConfig({ rootDir: import.meta.url });\n',
        'stryker.gates.config.mjs':
          `import { createStrykerGatesConfig } from ${JSON.stringify(helper('stryker'))};\n` +
          "export default createStrykerGatesConfig({ rootDir: import.meta.url, testRunner: 'vitest', " +
          "vitest: { configFile: 'vitest.gates.config.ts' }, concurrency: 1 });\n",
      });
      fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
      const run = (...args: string[]) => testGatesAsync(['mutation', '--dir', dir, ...args]);
      const SURVIVOR = '  - src/kinds.ts:1:21 / StringLiteral / \'b\' → "" (Survived)';
      const FAILED =
        'test-gates mutation: FAILED (mutants 9 / detected 8 (timeout 0) / allowed equivalent 0 / not evaluable 0 / unallowed survivors 1)';
      const PASSED =
        'test-gates mutation: OK (mutants 9 / detected 9 (timeout 0) / allowed equivalent 0 / not evaluable 0 / unallowed survivors 0)';

      // 1. First run: nothing to reuse. The spec never asks for 'b', so one mutant survives.
      const first = await run();
      expect(first.status).toBe(1);
      expect(first.stderr).toContain(SURVIVOR);
      expect(first.stderr).toContain(FAILED);
      expect(fs.existsSync(path.join(dir, 'reports/stryker-incremental.json'))).toBe(true);

      // 2. Nothing changed: every result is reused, and the JSON report is still complete.
      const second = await run();
      expect(second.stdout).toContain('9 of 9 mutant result(s) are reused');
      expect(second.status).toBe(1);
      expect(second.stderr).toContain(FAILED);
      expect(report(dir, 'reports/mutation/mutation.json')['src/kinds.ts']).toHaveLength(4);
      expect(report(dir, 'reports/mutation/mutation.json')['src/age.ts']).toHaveLength(5);

      // 3. A test that kills the survivor is added. The mutant is static, and the incremental
      //    run reuses its old "Survived": a false failure, never a false pass.
      write(dir, { 'src/kinds.spec.ts': SPEC_HEAD + KNOWS_A + KNOWS_B });
      const third = await run();
      expect(third.status).toBe(1);
      expect(third.stderr).toContain(SURVIVOR);

      // 4. --force retests everything and the run passes.
      const forced = await run('--force');
      expect(forced.stdout).toContain('0 of 9 mutant result(s) are reused');
      expect(forced.stdout).toContain(PASSED);
      expect(forced.status).toBe(0);

      // 5. A gate is removed. Its old results stay in the incremental file and come back in
      //    the report, but only the gates of test-gates.json are judged.
      write(dir, { 'test-gates.json': { gates: [gate('src/kinds.ts')], candidates: [] } });
      const removed = await run();
      expect(removed.status).toBe(0);
      expect(removed.stdout).toContain(
        'test-gates mutation: OK (mutants 4 / detected 4 (timeout 0) / allowed equivalent 0 / not evaluable 0 / unallowed survivors 0)'
      );
      expect(Object.keys(report(dir, 'reports/mutation/mutation.json')).sort()).toEqual([
        'src/age.ts',
        'src/kinds.ts',
      ]);
    }
  );
});

// The false pass the guard is there for: Stryker does not notice a change in a file that a
// spec imports, and would reuse the "Killed" of mutants that now survive.
describe.skipIf(!strykerRuns).each(['vitest', 'jest'] as const)(
  'test-gates mutation after a change that Stryker does not see (%s)',
  (runner) => {
    const NOTE =
      'test-gates mutation: running every mutant again (--force), the results of the last run are not reused: ';
    const ext = runner === 'vitest' ? 'ts' : 'js';
    const sources: {
      gate: string;
      helper: (assertion: string) => string;
      specHead: string;
      config: Record<string, string>;
      stryker: string;
    } =
      runner === 'vitest'
        ? {
            gate: "export const canRefund = (state: string, days: number) => state === 'paid' && days <= 14;\n",
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
            gate: "exports.canRefund = (state, days) => state === 'paid' && days <= 14;\n",
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
      'runs every mutant again and finds the survivors; reuses after a change of a gate or a spec',
      { timeout: 480_000 },
      async () => {
        const dir = project({
          'package.json': {
            name: 'guard-fixture',
            private: true,
            ...(runner === 'vitest' ? { type: 'module' } : {}),
          },
          'test-gates.json': { gates: [gate(`src/refund.${ext}`)], candidates: [] },
          [`src/refund.${ext}`]: sources.gate,
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
          `${NOTE}changed since the last run, and neither a gate nor its spec: src/expect-true.${ext}`
        );
        expect(reused(weakened.stdout)).toEqual([0, total]);
        expect(weakened.stderr).toMatch(
          /test-gates mutation: \d+ surviving mutant\(s\) not in the allow list/
        );
        expect(weakened.stderr).toContain(`  - src/refund.${ext}:1:`);
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

        // 6. Only the spec changes, then only the gate: Stryker compares those itself, and the
        //    results it can keep are reused as before.
        write(dir, {
          [`src/refund.spec.${ext}`]: `${SPEC}it('is a function', () => { expect(typeof canRefund).toBe('function'); });\n`,
        });
        const specOnly = await run();
        expect(specOnly.stdout).not.toContain(NOTE);
        // (How many results Stryker keeps after a change of a spec is its own business: with
        // Jest all but the mutants the new test covers, with Vitest none of this gate.)
        expect(reused(specOnly.stdout)).not.toBeNull();
        expect(specOnly.status).toBe(0);
        write(dir, { [`src/refund.${ext}`]: `${sources.gate}// the rule of 14 days\n` });
        const gateOnly = await run();
        expect(gateOnly.stdout).not.toContain(NOTE);
        expect(reused(gateOnly.stdout)).toEqual([total, total]);
        expect(gateOnly.status).toBe(0);
      }
    );
  }
);
