import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { cleanup, project, repoRoot, testGatesAsync, write } from './helpers';
import {
  KNOWS_A,
  KNOWS_B,
  SPEC_HEAD,
  gate,
  helper,
  report,
  strykerRuns,
} from './support/incremental';

afterAll(cleanup);

describe.skipIf(!strykerRuns)('test-gates mutation with the Stryker incremental file', () => {
  it(
    'judges a fully reused run, runs every mutant again after a spec changed, and ignores a removed gate',
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

      // 3. A test that kills the survivor is added. The mutant is static, and Stryker alone
      //    reuses its old "Survived". The spec changed, so the run is one of every mutant.
      write(dir, { 'src/kinds.spec.ts': SPEC_HEAD + KNOWS_A + KNOWS_B });
      const third = await run();
      expect(third.stdout).toContain(
        'the results of the last run are not reused: changed since the last run: src/kinds.spec.ts'
      );
      expect(third.stdout).toContain('0 of 9 mutant result(s) are reused');
      expect(third.stdout).toContain(PASSED);
      expect(third.status).toBe(0);

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

// Why `mutation --gate` is not the final check. A change in one gate (here together with its
// spec) can make a mutant of another gate survive: the spec of `next` compares through `same`,
// and `same` is made to tell less apart. Running only the mutants of the gate that changed and
// taking over the old results of the other one passes; the run of every mutant does not.
describe.skipIf(!strykerRuns)('test-gates mutation --gate with a real Stryker', () => {
  it(
    'judges only the gate it ran, and the run of every gate finds the survivor in the other',
    { timeout: 480_000 },
    async () => {
      const same = (body: string) =>
        `export const same = (left: number, right: number) => ${body};\n`;
      const sameSpec = (cases: string) =>
        "import { expect, it } from 'vitest';\nimport { same } from './same';\n" +
        `it('compares', () => {\n${cases}});\n`;
      const dir = project({
        'package.json': { name: 'gate-run-fixture', private: true, type: 'module' },
        'test-gates.json': { gates: [gate('src/same.ts'), gate('src/next.ts')], candidates: [] },
        'src/same.ts': same('left === right'),
        'src/same.spec.ts': sameSpec(
          '  expect(same(1, 1)).toBe(true);\n  expect(same(1, 2)).toBe(false);\n'
        ),
        'src/next.ts': 'export const next = (value: number) => value + 1;\n',
        'src/next.spec.ts':
          "import { expect, it } from 'vitest';\nimport { next } from './next';\nimport { same } from './same';\n" +
          "it('adds one', () => {\n  expect(same(next(2), 3)).toBe(true);\n});\n",
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
      const stryker = (...args: string[]) =>
        new Promise<number | null>((resolve, reject) => {
          const child = spawn(
            path.join(dir, 'node_modules/.bin/stryker'),
            ['run', 'stryker.gates.config.mjs', ...args],
            { cwd: dir, stdio: 'ignore' }
          );
          child.on('error', reject);
          child.on('close', resolve);
        });
      const SURVIVOR =
        '  - src/next.ts:1:40 / ArithmeticOperator / value + 1 → value - 1 (Survived)';

      // 1. Every mutant of both gates is killed.
      const first = await run();
      expect(first.stdout).toContain('unallowed survivors 0)');
      expect(first.status).toBe(0);

      // 2. `same` now only tells zero from the rest, and its spec is changed with it. Every
      //    mutant of `same` is still killed. `next(2)` with `value - 1` is 1, which is no
      //    longer told from 3.
      write(dir, {
        'src/same.ts': same('(left === 0) === (right === 0)'),
        'src/same.spec.ts': sameSpec(
          '  expect(same(1, 2)).toBe(true);\n  expect(same(0, 0)).toBe(true);\n' +
            '  expect(same(0, 2)).toBe(false);\n  expect(same(2, 0)).toBe(false);\n'
        ),
      });

      // 3. What must not be reported as a pass: Stryker runs the mutants of the changed gate
      //    only and takes the old results of the other gate over from its incremental file.
      //    Judged as a report of every gate, that passes.
      expect(await stryker('--mutate', 'src/same.ts')).toBe(0);
      const takenOver = await testGatesAsync(['mutation-result', '--dir', dir]);
      expect(takenOver.stdout).toContain('unallowed survivors 0)');
      expect(takenOver.status).toBe(0);

      // 4. `mutation --gate` runs the same mutants, judges that gate alone, and says so.
      const part = await run('--gate', 'src/same.ts');
      expect(part.stdout).toContain(
        'unallowed survivors 0). Only 1 of 2 gate(s) were run and judged (--gate)'
      );
      expect(part.stdout).toContain('run without --gate for the final check');
      expect(part.status).toBe(0);
      // Its report is gone, so `mutation-result` cannot judge it as one of every gate.
      expect((await testGatesAsync(['mutation-result', '--dir', dir])).status).toBe(1);

      // 5. The run of every gate after it takes nothing over, and fails.
      const full = await run();
      expect(full.stdout).toContain(
        'the results of the last run are not reused: there is no record of the run that wrote the incremental file'
      );
      expect(full.stderr).toContain(SURVIVOR);
      // (and the mutant that returns nothing: undefined is not told from 3 either)
      expect(full.stderr).toContain('unallowed survivors 2)');
      expect(full.status).toBe(1);
    }
  );
});
