import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { cleanup, project, repoRoot, testGatesAsync, write } from './helpers';
import { gate, helper, report, strykerRuns } from './support/incremental';

afterAll(cleanup);

const H = "import { expect, it } from 'vitest';\n";
const same = (body: string) =>
  "import { both } from './zero';\n" +
  `export const same = (left: number, right: number) => ${body};\n`;
const sameSpec = (cases: string) =>
  `${H}import { same } from './same';\nit('compares', () => {\n${cases}});\n`;
const STRICT = '  expect(same(1, 1)).toBe(true);\n  expect(same(1, 2)).toBe(false);\n';

// Three gates. `same` uses a helper, the spec of `next` checks its result through `same`, and
// `fee` stands alone.
function fixture(): string {
  const dir = project({
    'package.json': { name: 'affected-fixture', private: true, type: 'module' },
    'test-gates.json': {
      gates: [gate('src/same.ts'), gate('src/next.ts'), gate('src/fee.ts')],
      candidates: [],
    },
    'src/zero.ts': 'export const both = (a: boolean, b: boolean) => a === b;\n',
    'src/same.ts': same('left === right'),
    'src/same.spec.ts': sameSpec(STRICT),
    'src/next.ts': 'export const next = (value: number) => value + 1;\n',
    'src/next.spec.ts':
      `${H}import { next } from './next';\nimport { same } from './same';\n` +
      "it('adds one', () => {\n  expect(same(next(2), 3)).toBe(true);\n});\n",
    'src/fee.ts': 'export const fee = (kg: number) => (kg > 2 ? 9 : 5);\n',
    'src/fee.spec.ts':
      `${H}import { fee } from './fee';\n` +
      "it('goes by weight', () => {\n  expect(fee(2)).toBe(5);\n  expect(fee(3)).toBe(9);\n});\n",
    'src/unrelated.ts': 'export const banner = 1;\n',
    'vitest.gates.config.ts':
      `import { createVitestGatesConfig } from ${JSON.stringify(helper('vitest'))};\n` +
      'export default createVitestGatesConfig({ rootDir: import.meta.url });\n',
    'stryker.gates.config.mjs':
      `import { createStrykerGatesConfig } from ${JSON.stringify(helper('stryker'))};\n` +
      "export default createStrykerGatesConfig({ rootDir: import.meta.url, testRunner: 'vitest', " +
      "vitest: { configFile: 'vitest.gates.config.ts' }, concurrency: 1 });\n",
  });
  fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  return dir;
}

const FULL = 'test-gates mutation --affected: running every mutant again (--force)';
const OK = 'unallowed survivors 0)';

describe.skipIf(!strykerRuns)('test-gates mutation --affected with a real Stryker', () => {
  it(
    'runs again the gates a change can affect, keeps the others, and runs every mutant when it cannot tell',
    { timeout: 600_000 },
    async () => {
      const dir = fixture();
      const run = (env: NodeJS.ProcessEnv = {}) =>
        testGatesAsync(['mutation', '--dir', dir, '--affected'], env);
      const mutants = () =>
        Object.fromEntries(
          Object.entries(report(dir, 'reports/mutation/mutation.json')).map(([file, list]) => [
            file,
            list.length,
          ])
        );

      // 1. First run: every mutant.
      const first = await run();
      expect(first.stdout).toContain(
        `${FULL}, the results of the last run are not reused: there is no incremental file`
      );
      expect(first.stdout).toContain(OK);
      expect(first.status).toBe(0);
      const counts = mutants();

      // 2. Nothing changed: every gate is reused.
      const unchanged = await run();
      expect(unchanged.stdout).toContain(
        'test-gates mutation --affected: 3 of 3 gate(s) reused, 0 run again'
      );
      expect(unchanged.status).toBe(0);

      // 3. (a), (c), (f): the gate `same` changes. Its spec and the spec of `next` load it; `fee`
      //    is not touched, and neither is a file that no gate depends on.
      write(dir, {
        'src/same.ts': `${same('left === right')}// the same\n`,
        'src/unrelated.ts': 'export const banner = 2;\n',
      });
      const one = await run();
      expect(one.stdout).toContain(
        'test-gates mutation --affected: 1 of 3 gate(s) reused, 2 run again'
      );
      expect(one.stdout).toContain('  src/same.ts: changed src/same.ts');
      expect(one.stdout).toContain('  src/next.ts: changed src/same.ts');
      expect(one.stdout).toContain(OK);
      // The results of `fee` were taken over: the report still holds every gate.
      expect(mutants()).toEqual(counts);
      expect(one.status).toBe(0);
      const again = await run();
      expect(again.stdout).toContain('3 of 3 gate(s) reused, 0 run again');
      expect(again.stdout).toContain(OK);

      // 4. (b): the helper of `same` changes.
      write(dir, {
        'src/zero.ts': 'export const both = (a: boolean, b: boolean) => a === b; // x\n',
      });
      const helped = await run();
      expect(helped.stdout).toContain('1 of 3 gate(s) reused, 2 run again');
      expect(helped.stdout).toContain('  src/same.ts: changed src/zero.ts');
      expect(helped.stdout).toContain('  src/next.ts: changed src/zero.ts');

      // 5. (g), (c): only the spec of `next` kills a mutant of `same` (`left === right` → true).
      //    When that spec is weakened, `same` has to run again although neither it nor its own
      //    spec changed.
      const nextSpec = (extra: string) =>
        `${H}import { next } from './next';\nimport { same } from './same';\n` +
        `it('adds one', () => {\n  expect(same(next(2), 3)).toBe(true);\n${extra}});\n`;
      write(dir, {
        'src/same.spec.ts': sameSpec('  expect(same(1, 1)).toBe(true);\n'),
        'src/next.spec.ts': nextSpec('  expect(same(next(2), 4)).toBe(false);\n'),
      });
      const shifted = await run();
      expect(shifted.stdout).toContain('1 of 3 gate(s) reused, 2 run again');
      expect(shifted.stdout).toContain(OK);
      write(dir, { 'src/next.spec.ts': nextSpec('') });
      const weakSpec = await run();
      expect(weakSpec.stdout).toContain('1 of 3 gate(s) reused, 2 run again');
      expect(weakSpec.stdout).toContain('  src/same.ts: changed src/next.spec.ts');
      expect(weakSpec.stderr).toContain('ConditionalExpression / left === right → true (Survived)');
      expect(weakSpec.status).toBe(1);

      // 6. (g): `same` now tells only zero from the rest, and its own spec is changed with it.
      //    Every mutant of `same` is still killed; `value - 1` in `next` now survives, which a
      //    reuse of the old results of `next` would hide.
      write(dir, {
        'src/same.ts': same('both(left === 0, right === 0)'),
        'src/same.spec.ts': sameSpec(
          '  expect(same(1, 2)).toBe(true);\n  expect(same(0, 0)).toBe(true);\n' +
            '  expect(same(0, 2)).toBe(false);\n  expect(same(2, 0)).toBe(false);\n'
        ),
      });
      const weakened = await run();
      expect(weakened.stdout).toContain('1 of 3 gate(s) reused, 2 run again');
      expect(weakened.stderr).toContain(
        '  - src/next.ts:1:40 / ArithmeticOperator / value + 1 → value - 1 (Survived)'
      );
      expect(weakened.status).toBe(1);
      // A gate with a survivor is not reused: it runs again until it is clean.
      write(dir, { 'src/same.ts': same('left === right'), 'src/same.spec.ts': sameSpec(STRICT) });
      const restored = await run();
      expect(restored.stdout).toContain('1 of 3 gate(s) reused, 2 run again');
      expect(restored.stdout).toContain(OK);
      expect(restored.status).toBe(0);

      // 7. (d): a config and a lock file make the run one of every mutant.
      write(dir, {
        'vitest.gates.config.ts': `${fs.readFileSync(path.join(dir, 'vitest.gates.config.ts'), 'utf8')}// x\n`,
      });
      const config = await run();
      expect(config.stdout).toContain(
        `${FULL}, the results of the last run are not reused: changed since the last run, and may affect every gate: vitest.gates.config.ts`
      );
      expect(config.status).toBe(0);
      write(dir, { 'package-lock.json': '{}\n' });
      const lock = await run();
      expect(lock.stdout).toContain('may affect every gate: package-lock.json');

      // 8. (e): an import that cannot be followed makes the run one of every mutant.
      write(dir, {
        'src/fee.spec.ts': `${fs.readFileSync(path.join(dir, 'src/fee.spec.ts'), 'utf8')}// require(name)\n`,
      });
      const unknown = await run();
      expect(unknown.stdout).toContain(
        `${FULL}, the results of the last run are not reused: what a gate depends on cannot be told: src/fee.spec.ts:7 imports a module whose path is not written out`
      );
      expect(unknown.status).toBe(0);

      // 9. In CI every mutant is run.
      const ci = await run({ CI: 'true' });
      expect(ci.stdout).toContain(
        `${FULL}, the results of the last run are not reused: CI is set, and there every mutant is run (the final check)`
      );
      expect(ci.status).toBe(0);
    }
  );
});
