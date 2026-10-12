import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { cleanup, project, repoRoot, testGatesAsync } from './helpers';

afterAll(cleanup);

// `selfcheck` with a real Jest and a real Vitest, in a project that has every way in which the
// spec of one gate can reach another gate. The run in which the controls of several gates share
// one run of the gate command has to say exactly what a run per gate says (--one-by-one).

const helper = (name: string) => pathToFileURL(path.join(repoRoot, 'dist', `${name}.js`)).href;

const GATES = [
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
  'late', // the spec of `plain-one` calls one of its two functions in afterAll
];
const NOT_HELD = ['base', 'pair'];
/** Gates another spec (or the setup file) touches: they need a run of their own. */
const TOUCHED = ['base', 'pair', 'half', 'table', 'boot', 'late'];
/** Jest loads the real module to shape its automatic mock, which runs the top-level code. */
const TOUCHED_BY_JEST = [...TOUCHED, 'mocked'];

/** One module with the named functions, and a call of each. */
interface Dialect {
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
  mock: (from: string) => string;
  files: Record<string, string | object>;
  command: string[];
}

const vitest: Dialect = {
  ext: 'ts',
  module: (functions, head = '') =>
    head +
    Object.entries(functions)
      .map(([name, body]) => `export function ${name}(value: number): number {\n  ${body}\n}\n`)
      .join(''),
  use: (names, from) => `import { ${names.join(', ')} } from './${from}';\n`,
  load: (from) => `import './${from}';\n`,
  specHead: "import { afterAll, expect, it, vi } from 'vitest';\n",
  mock: (from) => `vi.mock('./${from}');\n`,
  files: {
    'package.json': { name: 'selfcheck-fixture', private: true, type: 'module' },
    'vitest.gates.config.ts':
      `import { createVitestGatesConfig } from ${JSON.stringify(helper('vitest'))};\n` +
      "export default createVitestGatesConfig({ rootDir: import.meta.url, coverageProvider: 'istanbul', test: { setupFiles: ['./src/setup.ts'] } });\n",
  },
  command: ['vitest', 'run', '--config', 'vitest.gates.config.ts'],
  touched: TOUCHED,
};

const jest: Dialect = {
  ext: 'js',
  module: (functions, head = '') =>
    head +
    Object.entries(functions)
      .map(([name, body]) => `exports.${name} = function ${name}(value) {\n  ${body}\n};\n`)
      .join(''),
  use: (names, from) => `const { ${names.join(', ')} } = require('./${from}');\n`,
  load: (from) => `require('./${from}');\n`,
  specHead: '',
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

function fixture(d: Dialect): Record<string, string | object> {
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
      d.use(['done'], 'late') +
      'afterAll(() => {\n  done(1);\n});\n' +
      test('doubles', 'expect(double(2)).toBe(4);\n  expect(halfOne(1)).toBe(2);'),
    [src('plain-two')]: d.module(double),
    [spec('plain-two')]:
      d.specHead +
      d.use(['double'], 'plain-two') +
      d.load('table') +
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

    [src('late')]: d.module({ done: 'return value;', other: 'return value + 1;' }),
    [spec('late')]:
      d.specHead +
      d.use(['done', 'other'], 'late') +
      test('ends', 'expect(done(1)).toBe(1);\n  expect(other(1)).toBe(2);'),
  };
}

describe.each([
  ['vitest', vitest],
  ['jest', jest],
] as const)('test-gates selfcheck with a real %s', (_name, dialect) => {
  it(
    'says in a shared run what it says in a run per gate, and gives touched gates their own run',
    { timeout: 600_000 },
    async () => {
      const dir = project(fixture(dialect));
      fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
      const runs = () => {
        const count = fs.readFileSync(path.join(dir, 'runs.log'), 'utf8').trim().split('\n').length;
        fs.rmSync(path.join(dir, 'runs.log'));
        return count;
      };
      const verdicts = (stderr: string) =>
        stderr
          .split('\n')
          .filter((line) => /^ {2}✗ |^ {6}hint: |^test-gates selfcheck:/.test(line));
      const src = (name: string) => `src/${name}.${dialect.ext}`;

      const perGate = await testGatesAsync(['selfcheck', '--one-by-one', '--dir', dir]);
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
        `  ✗ ${src('pair')}: the gate passed although the spec of ${src('pair')} was left out. The gate does not measure this file (does the gate config honor TEST_GATES_EXCLUDE_SPEC?)`,
        'test-gates selfcheck: FAILED (2 of 13 negative control(s))',
      ]);

      const shared = await testGatesAsync(['selfcheck', '--dir', dir]);
      // One run that records, one shared run, and a run for each gate something else touches.
      expect(runs()).toBe(2 + dialect.touched.length);
      expect(shared.status).toBe(perGate.status);
      expect(shared.stdout).toBe(perGate.stdout);
      expect(verdicts(shared.stderr)).toEqual(verdicts(perGate.stderr));
      expect(fs.readdirSync(dir).filter((name) => name.startsWith('.test-gates-touch'))).toEqual(
        []
      );

      // A part of the gates: the same lines for those gates.
      const part = await testGatesAsync(['selfcheck', '--shard', '1/2', '--dir', dir]);
      const partPerGate = await testGatesAsync([
        'selfcheck',
        '--shard',
        '1/2',
        '--one-by-one',
        '--dir',
        dir,
      ]);
      expect(part.stdout).toBe(partPerGate.stdout);
      expect(verdicts(part.stderr)).toEqual(verdicts(partPerGate.stderr));
      expect(part.status).toBe(partPerGate.status);
    }
  );
});
