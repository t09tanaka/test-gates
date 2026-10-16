import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { project, repoRoot, testGatesAsync } from '../helpers';

/** The output of --quick without the marks of the shared run: what a run per gate prints. */
export const withoutMarks = (stdout: string) =>
  stdout
    .replace(/, in the shared run\)/g, ')')
    .replace(/\. Of the controls that held, \d+ came from one shared run \(--quick\)[^\n]*/, '');

// `selfcheck` with a real Jest and a real Vitest, in a project that has every way in which the
// spec of one gate can reach another gate. The run in which the controls of several gates share
// one run of the gate command has to say exactly what a run per gate says (the default).

export const helper = (name: string) =>
  pathToFileURL(path.join(repoRoot, 'dist', `${name}.js`)).href;

// For a check by hand of the runs next to others: the number of rounds, and of runs at once.
export const STRESS = Number(process.env.TEST_GATES_STRESS ?? 0);
export const JOBS = process.env.TEST_GATES_STRESS_JOBS ?? '4';

export const GATES = [
  'plain-one', // only its own spec touches it
  'plain-two',
  'base', // the spec of `derived` covers all of it
  'derived',
  'pair', // the specs of `left` and `right` cover one half each: all of it together
  'left',
  'right',
  'half', // the spec of `plain-one` covers one of its two functions
  'table', // the spec of `plain-two` only loads it, which runs its top-level code
  'boot', // the setup file of the gate run calls one of its two functions, for every spec
  'mocked', // the spec of `uses` replaces it with a mock
  'uses',
  'late', // the spec of `plain-one` calls all of it in afterAll
  'swept', // the spec of `plain-two` calls all of it after every hook (see Dialect.lastOfAll)
];
export const NOT_HELD = ['base', 'pair', 'late', 'swept'];
/** Gates another spec (or the setup file) touches: they need a run of their own. */
export const TOUCHED = ['base', 'pair', 'half', 'table', 'boot', 'late', 'swept'];
/** Jest loads the real module to shape its automatic mock, which runs the top-level code. */
export const TOUCHED_BY_JEST = [...TOUCHED, 'mocked'];

/** One module with the named functions, and a call of each. */
export interface Dialect {
  ext: string;
  /** `export`ed functions; `body` maps a name to its body. */
  module: (functions: Record<string, string>, head?: string) => string;
  /** Import of names from a sibling module. */
  use: (names: string[], from: string) => string;
  /** Gates that need a run of their own with this runner. */
  touched: string[];
  /** Import for its effect only. */
  load: (from: string) => string;
  specHead: string;
  /** Code that runs `call` as late as the runner allows, after the afterAll hooks if it can. */
  lastOfAll: (call: string) => string;
  mock: (from: string) => string;
  files: Record<string, string | object>;
  command: string[];
}

export const vitest: Dialect = {
  ext: 'ts',
  module: (functions, head = '') =>
    head +
    Object.entries(functions)
      .map(([name, body]) => `export function ${name}(value: number): number {\n  ${body}\n}\n`)
      .join(''),
  use: (names, from) => `import { ${names.join(', ')} } from './${from}';\n`,
  load: (from) => `import './${from}';\n`,
  specHead: "import { afterAll, beforeAll, expect, it, vi } from 'vitest';\n",
  // The function a beforeAll returns runs after every afterAll.
  lastOfAll: (call) => `beforeAll(() => () => {\n  ${call}\n});\n`,
  mock: (from) => `vi.mock('./${from}');\n`,
  files: {
    'package.json': { name: 'selfcheck-fixture', private: true, type: 'module' },
    'vitest.gates.config.ts':
      `import { createVitestGatesConfig } from ${JSON.stringify(helper('vitest'))};\n` +
      "export default createVitestGatesConfig({ rootDir: import.meta.url, coverageProvider: 'istanbul', test: { setupFiles: ['./src/setup.ts'], sequence: { hooks: 'list' } } });\n",
  },
  command: ['vitest', 'run', '--config', 'vitest.gates.config.ts'],
  touched: TOUCHED,
};

export const jest: Dialect = {
  ext: 'js',
  module: (functions, head = '') =>
    head +
    Object.entries(functions)
      .map(([name, body]) => `exports.${name} = function ${name}(value) {\n  ${body}\n};\n`)
      .join(''),
  use: (names, from) => `const { ${names.join(', ')} } = require('./${from}');\n`,
  load: (from) => `require('./${from}');\n`,
  specHead: '',
  lastOfAll: (call) => `afterAll(() => {\n  ${call}\n});\n`,
  mock: (from) => `jest.mock('./${from}');\n`,
  files: {
    'package.json': { name: 'selfcheck-fixture', private: true },
    'jest.gates.config.js':
      `const { createJestGatesConfig } = require(${JSON.stringify(path.join(repoRoot, 'dist', 'jest.cjs'))});\n` +
      "module.exports = createJestGatesConfig({ rootDir: __dirname, setupFiles: ['<rootDir>/src/setup.js'] });\n",
  },
  command: ['jest', '--config', 'jest.gates.config.js'],
  touched: TOUCHED_BY_JEST,
};

export function fixture(d: Dialect): Record<string, string | object> {
  const src = (name: string) => `src/${name}.${d.ext}`;
  const spec = (name: string) => `src/${name}.spec.${d.ext}`;
  const double = { double: 'return value * 2;' };
  const two = { one: 'return value + 1;', two: 'return value + 2;' };
  const test = (name: string, body: string) => `it('${name}', () => {\n  ${body}\n});\n`;
  const both = 'expect(one(1)).toBe(2);\n  expect(two(1)).toBe(3);';
  return {
    ...d.files,
    'test-gates.json': {
      gates: GATES.map((name) => ({ path: src(name), decides: 'd', impact: 'i' })),
      candidates: [],
      settings: { gateCommand: ['node', 'run-gate.cjs', ...d.command] },
    },
    // Counts the runs of the gate command, then runs it.
    'run-gate.cjs':
      "const { spawnSync } = require('node:child_process');\n" +
      "require('node:fs').appendFileSync('runs.log', 'run\\n');\n" +
      'const [program, ...args] = process.argv.slice(2);\n' +
      "const result = spawnSync(require('node:path').join('node_modules', '.bin', program), args, { stdio: 'inherit' });\n" +
      'process.exit(result.status ?? 1);\n',
    [src('setup')]: d.use(['init'], 'boot') + 'init(1);\n',

    [src('plain-one')]: d.module(double),
    [spec('plain-one')]:
      d.specHead +
      d.use(['double'], 'plain-one') +
      d.use([d.ext === 'ts' ? 'one as halfOne' : 'one: halfOne'], 'half') +
      d.use([d.ext === 'ts' ? 'done, other as lateOther' : 'done, other: lateOther'], 'late') +
      'afterAll(() => {\n  done(1);\n  lateOther(1);\n});\n' +
      test('doubles', 'expect(double(2)).toBe(4);\n  expect(halfOne(1)).toBe(2);'),
    [src('plain-two')]: d.module(double),
    [spec('plain-two')]:
      d.specHead +
      d.use(['double'], 'plain-two') +
      d.load('table') +
      d.use(['sweep'], 'swept') +
      d.lastOfAll('sweep(1);') +
      test('doubles', 'expect(double(2)).toBe(4);'),

    [src('base')]: d.module({ grown: 'return value >= 18 ? 1 : 0;' }),
    [spec('base')]:
      d.specHead +
      d.use(['grown'], 'base') +
      test('is grown from 18', 'expect(grown(18)).toBe(1);\n  expect(grown(17)).toBe(0);'),
    [src('derived')]:
      d.use(['grown'], 'base') + d.module({ price: 'return grown(value) === 1 ? 10 : 5;' }),
    [spec('derived')]:
      d.specHead +
      d.use(['price'], 'derived') +
      test('prices by age', 'expect(price(18)).toBe(10);\n  expect(price(17)).toBe(5);'),

    [src('pair')]: d.module(two),
    [spec('pair')]: d.specHead + d.use(['one', 'two'], 'pair') + test('adds', both),
    [src('left')]: d.module(double),
    [spec('left')]:
      d.specHead +
      d.use(['double'], 'left') +
      d.use(['one'], 'pair') +
      test('doubles', 'expect(double(2)).toBe(4);\n  expect(one(1)).toBe(2);'),
    [src('right')]: d.module(double),
    [spec('right')]:
      d.specHead +
      d.use(['double'], 'right') +
      d.use(['two'], 'pair') +
      test('doubles', 'expect(double(2)).toBe(4);\n  expect(two(1)).toBe(3);'),

    [src('half')]: d.module(two),
    [spec('half')]: d.specHead + d.use(['one', 'two'], 'half') + test('adds', both),

    [src('table')]: d.module(
      { rate: 'return RATES[value] ?? 0;' },
      'const RATES = [0, 5, 7].map((rate) => rate * 2);\n'
    ),
    [spec('table')]:
      d.specHead +
      d.use(['rate'], 'table') +
      test('looks up', 'expect(rate(1)).toBe(10);\n  expect(rate(9)).toBe(0);'),

    [src('boot')]: d.module({ init: 'return value;', ready: 'return value + 1;' }),
    [spec('boot')]:
      d.specHead +
      d.use(['init', 'ready'], 'boot') +
      test('boots', 'expect(init(1)).toBe(1);\n  expect(ready(1)).toBe(2);'),

    [src('mocked')]: d.module({ fee: 'return value * 3;' }),
    [spec('mocked')]:
      d.specHead + d.use(['fee'], 'mocked') + test('charges', 'expect(fee(2)).toBe(6);'),
    [src('uses')]: d.use(['fee'], 'mocked') + d.module({ total: 'return fee(value);' }),
    [spec('uses')]:
      d.specHead +
      d.use(['fee'], 'mocked') +
      d.use(['total'], 'uses') +
      d.mock('mocked') +
      test('asks for the fee of the value', 'total(4);\n  expect(fee).toHaveBeenCalledWith(4);'),

    [src('swept')]: d.module({ sweep: 'return value;' }),
    [spec('swept')]:
      d.specHead + d.use(['sweep'], 'swept') + test('sweeps', 'expect(sweep(1)).toBe(1);'),
    [src('late')]: d.module({ done: 'return value;', other: 'return value + 1;' }),
    [spec('late')]:
      d.specHead +
      d.use(['done', 'other'], 'late') +
      test('ends', 'expect(done(1)).toBe(1);\n  expect(other(1)).toBe(2);'),
  };
}

// The same project with Vitest's other pool that is in the table of verified runs.
export const vitestThreads: Dialect = {
  ...vitest,
  command: [...vitest.command, '--pool=threads'],
};

export function sharedRunTests(only: string): void {
  describe.each(
    (
      [
        ['vitest', vitest],
        ['vitest in threads', vitestThreads],
        ['jest', jest],
      ] as const
    ).filter(([name]) => name === only)
  )('test-gates selfcheck with a real %s', (_name, dialect) => {
    it(
      'says in a shared run what it says in a run per gate, and gives touched gates their own run',
      { timeout: STRESS > 0 ? 7_200_000 : 600_000 },
      async () => {
        const dir = project(fixture(dialect));
        fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
        const runs = () => {
          const count = fs
            .readFileSync(path.join(dir, 'runs.log'), 'utf8')
            .trim()
            .split('\n').length;
          fs.rmSync(path.join(dir, 'runs.log'));
          return count;
        };
        const verdicts = (stderr: string) =>
          stderr
            .split('\n')
            .filter((line) => /^ {2}✗ |^ {6}hint: |^test-gates selfcheck:/.test(line));
        const src = (name: string) => `src/${name}.${dialect.ext}`;

        const perGate = await testGatesAsync(['selfcheck', '--dir', dir]);
        expect(runs()).toBe(GATES.length);
        // What the fixture is built to show, as the run per gate sees it.
        expect(perGate.status).toBe(1);
        expect(perGate.stdout.trimEnd().split('\n')).toEqual(
          GATES.filter((name) => !NOT_HELD.includes(name)).map(
            (name) => `  ✓ without src/${name}.spec.${dialect.ext} the gate fails (exit 1)`
          )
        );
        expect(verdicts(perGate.stderr)).toEqual([
          `  ✗ ${src('base')}: the gate passed although the spec of ${src('base')} was left out. The gate does not measure this file (does the gate config honor TEST_GATES_EXCLUDE_SPEC?)`,
          `      hint: ${src('derived')} import(s) this gate, so their specs cover it without its own spec. Mock the import in those specs and assert the call (toHaveBeenCalledWith), so that each spec only covers its own gate`,
          ...['pair', 'late', 'swept'].map(
            (name) =>
              `  ✗ ${src(name)}: the gate passed although the spec of ${src(name)} was left out. The gate does not measure this file (does the gate config honor TEST_GATES_EXCLUDE_SPEC?)`
          ),
          'test-gates selfcheck: FAILED (4 of 14 negative control(s))',
        ]);

        const shared = await testGatesAsync(['selfcheck', '--quick', '--dir', dir]);
        // One run that records, one shared run, and a run for each gate something else touches.
        expect(runs()).toBe(2 + dialect.touched.length);
        expect(shared.status).toBe(perGate.status);
        // The same lines, apart from what marks a control as judged in the shared run.
        expect(withoutMarks(shared.stdout)).toBe(perGate.stdout);
        expect(shared.stdout).toContain(', in the shared run)');
        expect(verdicts(withoutMarks(shared.stderr))).toEqual(verdicts(perGate.stderr));
        expect(fs.readdirSync(dir).filter((name) => name.startsWith('.test-gates-touch'))).toEqual(
          []
        );

        // A part of the gates: the same lines for those gates.
        const part = await testGatesAsync(['selfcheck', '--quick', '--shard', '1/2', '--dir', dir]);
        const partPerGate = await testGatesAsync(['selfcheck', '--shard', '1/2', '--dir', dir]);
        expect(withoutMarks(part.stdout)).toBe(partPerGate.stdout);
        expect(verdicts(withoutMarks(part.stderr))).toEqual(verdicts(partPerGate.stderr));
        expect(part.status).toBe(partPerGate.status);

        // Several controls at the same time (the gate command has to be the runner itself for
        // that, with the pool of this dialect): the lines of one at a time, whatever had to be
        // run again.
        const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'test-gates.json'), 'utf8'));
        fs.writeFileSync(
          path.join(dir, 'test-gates.json'),
          JSON.stringify({ ...manifest, settings: { gateCommand: dialect.command } })
        );
        const again =
          /^test-gates selfcheck: (\d+) of \d+ negative control\(s\) did not hold cleanly[^\n]*\n/;
        const counts: number[] = [];
        for (let round = 0; round < Math.max(1, STRESS); round += 1) {
          const atOnce = await testGatesAsync(['selfcheck', '--jobs', JOBS, '--dir', dir]);
          expect(atOnce.stdout).not.toContain('one negative control at a time');
          expect(atOnce.stdout.replace(again, '')).toBe(perGate.stdout);
          expect(verdicts(atOnce.stderr)).toEqual(verdicts(perGate.stderr));
          expect(atOnce.status).toBe(perGate.status);
          // The controls that do not hold needed a run of their own. On a quiet machine none
          // that holds does; under load any of them may.
          const count = Number(again.exec(atOnce.stdout)?.[1]);
          expect(count).toBeGreaterThanOrEqual(NOT_HELD.length);
          counts.push(count);
        }
        if (STRESS > 0) {
          console.log(`${_name}: --jobs ${JOBS}, ${STRESS} rounds, run again: ${counts.join(' ')}`);
        }
        expect(fs.readdirSync(dir).filter((name) => name.startsWith('.test-gates'))).toEqual([]);
      }
    );
  });
}

// What a run next to others can show of a disturbance. Both projects were first built as
// counterexamples: a control that does not hold on its own was reported as holding with
// --jobs, because the run next to others lost a lock to another run. Here the lock is taken
// inside a package the project vouches for, so nothing in the text of the project speaks
// against running at the same time; the summary of the runner has to.
export function jobsTests(only: 'vitest' | 'jest'): void {
  describe.each(
    (
      [
        [
          'vitest, when a test skips itself',
          vitest,
          // The spec that also covers `victim` skips that test when it does not get the lock.
          "it('covers the other gate', async (context) => {\n  if (!take()) {\n    context.skip();\n  }\n  price(1);\n  price(0);\n  await hold();\n  give();\n});\n",
          '',
        ],
        [
          'jest, when a test fails and the reporter does not say so',
          jest,
          "it('covers the other gate', async () => {\n  expect(take()).toBe(true);\n  price(1);\n  price(0);\n  await hold();\n  give();\n});\n",
          "reporters: ['<rootDir>/quiet.js'], ",
        ],
      ] as const
    ).filter(([, dialect]) => dialect === (only === 'vitest' ? vitest : jest))
  )('test-gates selfcheck --jobs with a real %s', (_name, dialect, covering, reporters) => {
    it(
      'runs the control again on its own, and says what one at a time says',
      { timeout: 600_000 },
      async () => {
        const names = ['one', 'two', 'three', 'victim', 'attacker'];
        const src = (name: string) => `src/${name}.${dialect.ext}`;
        const root = project({
          // Above the project, where the walk through the imports finds it as a package.
          'node_modules/lock-fixture/package.json': { name: 'lock-fixture', version: '1.0.0' },
          'node_modules/lock-fixture/index.js':
            "const fs = require('node:fs');\n" +
            "exports.take = () => {\n  try {\n    fs.closeSync(fs.openSync('taken.lock', 'wx'));\n    return true;\n  } catch {\n    return false;\n  }\n};\n" +
            "exports.give = () => fs.rmSync('taken.lock', { force: true });\n" +
            'exports.hold = () => new Promise((done) => setTimeout(done, 1500));\n',
          ...Object.fromEntries(
            Object.entries({
              ...dialect.files,
              'quiet.js': 'module.exports = class Quiet {};\n',
              'test-gates.json': {
                gates: names.map((name) => ({ path: src(name), decides: 'd', impact: 'i' })),
                candidates: [],
                settings: { imports: { mode: 'allowlist', allow: ['lock-fixture'] } },
              },
              ...Object.fromEntries(
                names.flatMap((name) => [
                  [src(name), dialect.module({ price: 'return value ? 10 : 5;' })],
                  [
                    `src/${name}.spec.${dialect.ext}`,
                    dialect.specHead +
                      dialect.use(['price'], name) +
                      "it('prices', () => {\n  expect(price(1)).toBe(10);\n  expect(price(0)).toBe(5);\n});\n",
                  ],
                ])
              ),
              [`src/attacker.spec.${dialect.ext}`]:
                dialect.specHead +
                dialect.use(['price'], 'victim') +
                dialect.use([dialect.ext === 'ts' ? 'price as own' : 'price: own'], 'attacker') +
                (dialect.ext === 'ts'
                  ? "import { give, hold, take } from 'lock-fixture';\n"
                  : "const { give, hold, take } = require('lock-fixture');\n") +
                "it('prices', () => {\n  expect(own(1)).toBe(10);\n  expect(own(0)).toBe(5);\n});\n" +
                covering,
            }).map(([file, content]) => [`app/${file}`, content])
          ),
        });
        const dir = path.join(root, 'app');
        fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
        const config = fs
          .readdirSync(dir)
          .find((name) => name.includes('.gates.config.')) as string;
        // (no setup file in this project)
        fs.writeFileSync(
          path.join(dir, config),
          fs
            .readFileSync(path.join(dir, config), 'utf8')
            .replace(/setupFiles: \[[^\]]*\],? ?/, reporters)
        );
        const verdicts = (result: { stdout: string; stderr: string }) =>
          `${result.stdout}${result.stderr}`
            .split('\n')
            .filter((line) => /^ {2}[✓✗] |^test-gates selfcheck: (?:OK|FAILED)/.test(line));

        const perGate = await testGatesAsync(['selfcheck', '--dir', dir]);
        // One at a time the lock is always free, so the other spec covers `victim` as well.
        expect(perGate.status).toBe(1);
        expect(verdicts(perGate).filter((line) => line.startsWith('  ✗'))).toEqual([
          expect.stringContaining(`  ✗ ${src('victim')}: the gate passed although the spec`),
        ]);

        const atOnce = await testGatesAsync(['selfcheck', '--jobs', '5', '--dir', dir]);
        expect(atOnce.stdout).not.toContain('one negative control at a time');
        expect(verdicts(atOnce)).toEqual(verdicts(perGate));
        expect(atOnce.status).toBe(1);
        // Four runs want the lock at the same time and one gets it.
        const again = /(\d+) of 5 negative control\(s\) did not hold cleanly/.exec(atOnce.stdout);
        expect(Number(again?.[1])).toBeGreaterThanOrEqual(2);
      }
    );

    it(
      'runs on its own only the control of a gate that a spec reaching outside loads, and says what one at a time says',
      { timeout: 600_000 },
      async () => {
        // `covered`: the spec of `two` covers all of it. `watched`: the spec of `three` covers
        // all of it and reads files. `clock`: its own spec reads the clock.
        const names = ['two', 'three', 'covered', 'watched', 'clock'];
        const src = (name: string) => `src/${name}.${dialect.ext}`;
        const prices =
          "it('prices', () => {\n  expect(price(1)).toBe(10);\n  expect(price(0)).toBe(5);\n});\n";
        const own = (name: string) => dialect.use(['price'], name);
        const also = (name: string) =>
          dialect.use([dialect.ext === 'ts' ? 'price as other' : 'price: other'], name) +
          "it('prices the other', () => {\n  expect(other(1)).toBe(10);\n  expect(other(0)).toBe(5);\n});\n";
        const files =
          (dialect.ext === 'ts'
            ? "import fs from 'node:fs';\n"
            : "const fs = require('node:fs');\n") +
          "it('reads', () => {\n  expect(fs.existsSync('.')).toBe(true);\n});\n";
        const specs: Record<string, string> = {
          two: own('two') + prices + also('covered'),
          three: own('three') + prices + also('watched') + files,
          clock:
            own('clock') +
            prices +
            "it('reads the clock', () => {\n  expect(Date.now()).toBeGreaterThan(0);\n});\n",
        };
        const dir = project({
          ...dialect.files,
          'test-gates.json': {
            gates: names.map((name) => ({ path: src(name), decides: 'd', impact: 'i' })),
            candidates: [],
          },
          ...Object.fromEntries(
            names.flatMap((name) => [
              [src(name), dialect.module({ price: 'return value ? 10 : 5;' })],
              [
                `src/${name}.spec.${dialect.ext}`,
                dialect.specHead + (specs[name] ?? own(name) + prices),
              ],
            ])
          ),
        });
        fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
        const config = fs
          .readdirSync(dir)
          .find((name) => name.includes('.gates.config.')) as string;
        fs.writeFileSync(
          path.join(dir, config),
          fs.readFileSync(path.join(dir, config), 'utf8').replace(/setupFiles: \[[^\]]*\],? ?/, '')
        );
        const verdicts = (result: { stdout: string; stderr: string }) =>
          `${result.stdout}${result.stderr}`
            .split('\n')
            .filter((line) => /^ {2}[✓✗] |^test-gates selfcheck: (?:OK|FAILED)/.test(line));

        const perGate = await testGatesAsync(['selfcheck', '--dir', dir]);
        expect(perGate.status).toBe(1);
        expect(verdicts(perGate).filter((line) => line.startsWith('  ✗'))).toEqual([
          expect.stringContaining(`  ✗ ${src('covered')}: the gate passed although the spec`),
          expect.stringContaining(`  ✗ ${src('watched')}: the gate passed although the spec`),
        ]);

        const atOnce = await testGatesAsync(['selfcheck', '--jobs', '4', '--dir', dir]);
        expect(verdicts(atOnce)).toEqual(verdicts(perGate));
        expect(atOnce.status).toBe(1);
        const said = atOnce.stdout.split('\n');
        expect(said.slice(0, 2)).toEqual([
          'test-gates selfcheck: 1 of 5 negative control(s) run one at a time, since in their runs something that loads the gate also loads a file that may meet what another run is doing:',
          `  ${src('watched')}: loaded by src/three.spec.${dialect.ext}, in which src/three.spec.${dialect.ext} imports node:fs`,
        ]);
        // The four others ran next to each other. The control of `covered` did not hold there,
        // so it ran again on its own, and that run is the one reported.
        expect(said[2]).toBe(
          'test-gates selfcheck: 1 of 4 negative control(s) did not hold cleanly next to others and run again on their own'
        );
      }
    );
  });
}
