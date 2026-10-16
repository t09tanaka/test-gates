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

// Two gates. `rate` imports `./scale`, for which there are both scale.ts and scale.js (Vite
// loads scale.js), and `fee` stands alone.
function twinsFixture(): string {
  const dir = project({
    'package.json': { name: 'affected-twins', private: true, type: 'module' },
    'test-gates.json': { gates: [gate('src/rate.ts'), gate('src/fee.ts')], candidates: [] },
    'src/scale.ts': 'export const scale: number = 2;\n',
    'src/scale.js': 'export const scale = 2;\n',
    'src/rate.ts':
      "import { scale } from './scale';\nexport const rate = (x: number) => x * scale;\n",
    'src/rate.spec.ts': `${H}import { rate } from './rate';\nit('scales', () => { expect(rate(3)).toBe(6); });\n`,
    'src/fee.ts': 'export const fee = (kg: number) => (kg > 2 ? 9 : 5);\n',
    'src/fee.spec.ts':
      `${H}import { fee } from './fee';\n` +
      "it('goes by weight', () => {\n  expect(fee(2)).toBe(5);\n  expect(fee(3)).toBe(9);\n});\n",
    'src/locales/ja.ts': "export const word = 'ja';\n",
    'src/shims/colors.ts': 'export default { factor: 2 };\n',
    'vitest.gates.config.ts': vitestConfig(''),
    'stryker.gates.config.mjs':
      `import { createStrykerGatesConfig } from ${JSON.stringify(helper('stryker'))};\n` +
      "export default createStrykerGatesConfig({ rootDir: import.meta.url, testRunner: 'vitest', " +
      "vitest: { configFile: 'vitest.gates.config.ts' }, concurrency: 1 });\n",
  });
  fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  return dir;
}
function vitestConfig(options: string): string {
  return (
    "import path from 'node:path';\nimport { fileURLToPath } from 'node:url';\n" +
    `import { createVitestGatesConfig } from ${JSON.stringify(helper('vitest'))};\n` +
    `export default createVitestGatesConfig({ rootDir: import.meta.url${options} });\n`
  );
}

describe.skipIf(!strykerRuns)('what --affected cannot follow, with a real Stryker', () => {
  it(
    'runs again a gate whose import has two files, and every mutant for an import put together or a map of the runner',
    { timeout: 600_000 },
    async () => {
      const dir = twinsFixture();
      const run = () => testGatesAsync(['mutation', '--dir', dir, '--affected']);
      const cannot = `${FULL}, the results of the last run are not reused: what a gate depends on cannot be told: `;
      expect((await run()).status).toBe(0);

      // scale.js is the file Vite loads for ./scale.
      write(dir, { 'src/scale.js': 'export const scale = 2; // x\n' });
      const twin = await run();
      expect(twin.stdout).toContain('1 of 2 gate(s) reused, 1 run again');
      expect(twin.stdout).toContain('  src/rate.ts: changed src/scale.js');
      expect(twin.status).toBe(0);

      // An import put together from strings: its path is not written out.
      const feeSpec = fs.readFileSync(path.join(dir, 'src/fee.spec.ts'), 'utf8');
      write(dir, {
        'src/fee.spec.ts': `${feeSpec}export const load = (lang: string) => import('./locales/' + lang + '.ts');\n`,
      });
      const joined = await run();
      expect(joined.stdout).toContain(
        `${cannot}src/fee.spec.ts:7 imports a module whose path is not written out`
      );
      expect(joined.status).toBe(0);
      write(dir, { 'src/fee.spec.ts': feeSpec });
      expect((await run()).status).toBe(0);

      // An installed package that the runner config maps to a file of the project: this tool
      // would take the package, so a change of the file cannot be told gate by gate.
      write(dir, {
        'vitest.gates.config.ts': vitestConfig(
          ", resolve: { alias: { picocolors: path.join(path.dirname(fileURLToPath(import.meta.url)), 'src/shims/colors.ts') } }"
        ),
        'src/rate.ts':
          "import { scale } from './scale';\nimport colors from 'picocolors';\n" +
          'export const rate = (x: number) => x * scale * (colors as unknown as { factor: number }).factor / 2;\n',
      });
      const mapped = `${cannot}vitest.gates.config.ts maps picocolors with alias in a way settings.importAliases does not name`;
      const config = await run();
      expect(config.stdout).toContain(mapped);
      expect(config.status).toBe(0);
      write(dir, { 'src/shims/colors.ts': 'export default { factor: 2 }; // x\n' });
      const shim = await run();
      expect(shim.stdout).toContain(mapped);
      expect(shim.status).toBe(0);
    }
  );
});

describe.skipIf(!strykerRuns)('a run without --affected, with a real Stryker', () => {
  it(
    'writes down what each gate depends on for the next run with --affected, but not with --gate or in CI',
    { timeout: 600_000 },
    async () => {
      const dir = fixture();
      // Not in CI unless a step says so: a run there writes nothing about the gates.
      const plain = (args: string[] = [], env: NodeJS.ProcessEnv = { CI: 'false' }) =>
        testGatesAsync(['mutation', '--dir', dir, ...args], env);
      const affected = () => testGatesAsync(['mutation', '--dir', dir, '--affected']);
      let edits = 0;
      const changeFee = () => {
        edits += 1;
        write(dir, {
          'src/fee.ts': `export const fee = (kg: number) => (kg > 2 ? 9 : 5); // ${edits}\n`,
        });
      };
      const onlyFee = async () => {
        changeFee();
        const run = await affected();
        expect(run.stdout).toContain(
          'test-gates mutation --affected: 2 of 3 gate(s) reused, 1 run again'
        );
        expect(run.stdout).toContain('  src/fee.ts: changed src/fee.ts');
        expect(run.stdout).toContain(OK);
        expect(run.status).toBe(0);
      };

      // A first run of every mutant, then a change that only `fee` depends on.
      const first = await plain();
      expect(first.stdout).toContain(OK);
      expect(first.status).toBe(0);
      await onlyFee();

      // A run that takes every result over keeps what was written down about the gates.
      const reused = await plain();
      expect(reused.stdout).not.toContain('running every mutant again');
      expect(reused.status).toBe(0);
      await onlyFee();

      // A full run by hand.
      const forced = await plain(['--', '--force']);
      expect(forced.stdout).toContain(OK);
      expect(forced.status).toBe(0);
      await onlyFee();

      // A run of one gate leaves no record.
      const part = await plain(['--gate', 'src/fee.ts']);
      expect(part.status).toBe(0);
      const afterPart = await affected();
      expect(afterPart.stdout).toContain(
        `${FULL}, the results of the last run are not reused: there is no record of the run that wrote the incremental file`
      );

      // A run in CI writes nothing about the gates: after a change, every mutant is run.
      const ci = await plain([], { CI: 'true' });
      expect(ci.status).toBe(0);
      changeFee();
      const afterCi = await affected();
      expect(afterCi.stdout).toContain(
        `${FULL}, the results of the last run are not reused: the last run did not write down what each gate depends on`
      );
      expect(afterCi.status).toBe(0);
    }
  );
});

// `countUp` has two mutants that can never end; test-gates.json lists them as expected
// timeouts, and a run after no change takes them over. Any other timeout may come from a loaded
// machine, where the mutant would have survived, so it is never taken over from the last run.
function timeoutsFixture(): string {
  const dir = project({
    'package.json': { name: 'timeouts-fixture', private: true, type: 'module' },
    'test-gates.json': {
      gates: [
        {
          path: 'src/count.ts',
          decides: 'd',
          impact: 'i',
          expectedTimeouts: [
            {
              mutator: 'BlockStatement',
              original: '{ i += 1; }',
              replacement: '{}',
              reason: 'the loop no longer ends',
            },
            {
              mutator: 'AssignmentOperator',
              original: 'i += 1',
              replacement: 'i -= 1',
              reason: 'the loop no longer ends',
            },
          ],
        },
        { path: 'src/fee.ts', decides: 'd', impact: 'i' },
      ],
      candidates: [],
    },
    'src/count.ts':
      'export function countUp(n: number): number {\n  let i = 0;\n  while (i < n) {\n    i += 1;\n  }\n  return i;\n}\n',
    'src/count.spec.ts':
      `${H}import { countUp } from './count';\n` +
      "it('counts', () => {\n  expect(countUp(3)).toBe(3);\n  expect(countUp(0)).toBe(0);\n});\n",
    'src/fee.ts': 'export const fee = (kg: number) => (kg > 2 ? 9 : 5);\n',
    'src/fee.spec.ts':
      `${H}import { fee } from './fee';\n` +
      "it('goes by weight', () => {\n  expect(fee(2)).toBe(5);\n  expect(fee(3)).toBe(9);\n});\n",
    'vitest.gates.config.ts':
      `import { createVitestGatesConfig } from ${JSON.stringify(helper('vitest'))};\n` +
      'export default createVitestGatesConfig({ rootDir: import.meta.url });\n',
    'stryker.gates.config.mjs':
      `import { createStrykerGatesConfig } from ${JSON.stringify(helper('stryker'))};\n` +
      "export default createStrykerGatesConfig({ rootDir: import.meta.url, testRunner: 'vitest', " +
      "vitest: { configFile: 'vitest.gates.config.ts' }, concurrency: 1, timeoutMS: 1000 });\n",
  });
  fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  return dir;
}

/**
 * Turns the results of the comparison `kg > 2` of `fee` in the incremental file into timeouts,
 * as a loaded machine can leave them, and keeps the record of the run with it.
 */
async function timedOutUnderLoad(dir: string): Promise<number> {
  const file = path.join(dir, 'reports/stryker-incremental.json');
  const stored = JSON.parse(fs.readFileSync(file, 'utf8')) as {
    files: Record<string, { mutants: Array<{ mutatorName: string; status: string }> }>;
  };
  let changed = 0;
  for (const mutant of stored.files['src/fee.ts']?.mutants ?? []) {
    if (mutant.mutatorName === 'EqualityOperator' && mutant.status === 'Killed') {
      mutant.status = 'Timeout';
      changed += 1;
    }
  }
  expect(changed).toBeGreaterThan(0);
  fs.writeFileSync(file, JSON.stringify(stored));
  // The record has to belong to the incremental file as it is now.
  const record = `${file}.test-gates.json`;
  const kept = JSON.parse(fs.readFileSync(record, 'utf8')) as { incremental: string };
  const { createHash } = await import('node:crypto');
  kept.incremental = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  fs.writeFileSync(record, JSON.stringify(kept));
  return changed;
}

describe.skipIf(!strykerRuns)('mutants that timed out in the last run, with a real Stryker', () => {
  const TAKEN_OVER =
    'mutant(s) that timed out in the last run are taken over: expectedTimeouts lists them';

  it(
    'are run again also in a gate whose other results are reused, unless expectedTimeouts lists them, with and without --affected',
    { timeout: 300_000 },
    async () => {
      const dir = timeoutsFixture();
      const run = (...args: string[]) => testGatesAsync(['mutation', '--dir', dir, ...args]);

      const first = await run('--affected');
      expect(first.stdout).toContain(
        '(timeout 2) / allowed equivalent 0 / not evaluable 0 / unallowed survivors 0)'
      );
      expect(first.status).toBe(0);

      // Nothing changed: both gates are reused, and so are the two timeouts that
      // expectedTimeouts lists. Nothing is run again.
      const second = await run('--affected');
      expect(second.stdout).toContain(
        'test-gates mutation --affected: 2 of 2 gate(s) reused, 0 run again'
      );
      expect(second.stdout).toContain(`  2 ${TAKEN_OVER}`);
      expect(second.stdout).not.toContain('of reused gates that timed out');
      expect(second.stdout).toContain(
        '(timeout 2) / allowed equivalent 0 / not evaluable 0 / unallowed survivors 0)'
      );
      expect(second.status).toBe(0);

      // A gate that is run again for a change, next to one whose expected timeouts are reused.
      write(dir, { 'src/fee.ts': 'export const fee = (kg: number) => (kg > 2 ? 9 : 5); // x\n' });
      const both = await run('--affected');
      expect(both.stdout).toContain('1 of 2 gate(s) reused, 1 run again');
      expect(both.stdout).toContain('  src/fee.ts: changed src/fee.ts');
      expect(both.stdout).toContain(`  2 ${TAKEN_OVER}`);
      expect(both.stdout).not.toContain('of reused gates that timed out');
      expect(both.stdout).toContain(
        '(timeout 2) / allowed equivalent 0 / not evaluable 0 / unallowed survivors 0)'
      );

      // Timeouts left by a loaded machine are not taken over: run again, the mutants are killed.
      const underLoad = await timedOutUnderLoad(dir);
      const loaded = await run('--affected');
      expect(loaded.stdout).toContain('2 of 2 gate(s) reused, 0 run again');
      expect(loaded.stdout).toContain(
        `  and ${underLoad} mutant(s) of reused gates that timed out in the last run`
      );
      expect(loaded.stdout).toContain(`  2 ${TAKEN_OVER}`);
      expect(loaded.stdout).toContain(
        '(timeout 2) / allowed equivalent 0 / not evaluable 0 / unallowed survivors 0)'
      );
      expect(loaded.status).toBe(0);

      // Without --affected, a run after no change reuses the expected timeouts as well...
      const unchanged = await run();
      expect(unchanged.stdout).toContain(`test-gates mutation: 2 ${TAKEN_OVER}`);
      expect(unchanged.stdout).not.toContain('are run again');
      expect(unchanged.stdout).toContain(
        '(timeout 2) / allowed equivalent 0 / not evaluable 0 / unallowed survivors 0)'
      );
      expect(unchanged.status).toBe(0);

      // ...and runs the other timeouts again.
      const again = await timedOutUnderLoad(dir);
      const plain = await run();
      expect(plain.stdout).toContain(
        `test-gates mutation: ${again} mutant(s) that timed out in the last run are run again, the other results are reused`
      );
      expect(plain.stdout).toContain(`test-gates mutation: 2 ${TAKEN_OVER}`);
      expect(plain.stdout).toContain(
        '(timeout 2) / allowed equivalent 0 / not evaluable 0 / unallowed survivors 0)'
      );
      expect(plain.status).toBe(0);
    }
  );
});
