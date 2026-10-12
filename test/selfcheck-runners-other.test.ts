import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { cleanup, project, repoRoot, testGatesAsync } from './helpers';
import { jest, vitest } from './support/selfcheck-runners';

afterAll(cleanup);

// How long `selfcheck` takes with --jobs, for the README. Not a test of anything: it runs only
// when asked, as `TEST_GATES_MEASURE=<gates> npm run test:heavy -- -t "takes with"`.
const MEASURE = Number(process.env.TEST_GATES_MEASURE ?? 0);

describe.skipIf(MEASURE === 0).each([
  ['vitest', vitest, '--no-file-parallelism'],
  ['jest', jest, '--runInBand'],
] as const)('how long test-gates selfcheck takes with %s', (name, dialect, oneWorker) => {
  it('prints the seconds', { timeout: 7_200_000 }, async () => {
    const names = Array.from({ length: MEASURE }, (_unused, index) => `gate${index + 1}`);
    const dir = project({
      ...dialect.files,
      ...Object.fromEntries(
        names.flatMap((gate) => [
          [`src/${gate}.${dialect.ext}`, dialect.module({ price: 'return value ? 10 : 5;' })],
          [
            `src/${gate}.spec.${dialect.ext}`,
            dialect.specHead +
              dialect.use(['price'], gate) +
              "it('prices', () => {\n  expect(price(1)).toBe(10);\n  expect(price(0)).toBe(5);\n});\n",
          ],
        ])
      ),
    });
    fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
    const config = fs.readdirSync(dir).find((file) => file.includes('.gates.config.')) as string;
    fs.writeFileSync(
      path.join(dir, config),
      fs.readFileSync(path.join(dir, config), 'utf8').replace(/setupFiles: \[[^\]]*\],? ?/, '')
    );
    const lines: string[] = [];
    for (const workers of [[], [oneWorker]]) {
      fs.writeFileSync(
        path.join(dir, 'test-gates.json'),
        JSON.stringify({
          gates: names.map((gate) => ({
            path: `src/${gate}.${dialect.ext}`,
            decides: 'd',
            impact: 'i',
          })),
          candidates: [],
          settings: { gateCommand: [...dialect.command, ...workers] },
        })
      );
      for (const jobs of ['1', '2', '4', '8']) {
        const start = Date.now();
        const result = await testGatesAsync(['selfcheck', '--jobs', jobs, '--dir', dir]);
        expect(result.stdout.trimEnd().split('\n')).toHaveLength(MEASURE + 1);
        expect(result.status).toBe(0);
        lines.push(
          `${name} ${workers.join(' ') || '(default workers)'} --jobs ${jobs}: ${((Date.now() - start) / 1000).toFixed(1)} s`
        );
      }
    }
    console.log(`${MEASURE} gates\n${lines.join('\n')}`);
  });
});

// Notes that miss something. The first version of the shared run took the note of a spec in
// an `afterAll` of a setup file. What ran after that hook was not in the note: a cleanup
// function returned by `beforeAll`, and with the hooks in the order written, the `afterAll` of
// the spec itself. A gate that another spec covered there was then taken for one that only its
// own spec touches. This gate config takes its notes that way again, to show that the check of
// the notes against the runner's own total refuses them.
describe('test-gates selfcheck with notes taken too early (Vitest)', () => {
  const index = pathToFileURL(path.join(repoRoot, 'dist', 'index.js')).href;
  const CONFIG = `import path from 'node:path';
import { gateSpecs, loadGates } from ${JSON.stringify(index)};

const root = path.dirname(new URL(import.meta.url).pathname);
const manifest = loadGates(root);
const touch = process.env.TEST_GATES_TOUCH_DIR;
export default {
  root,
  test: {
    include: gateSpecs(manifest),
    passWithNoTests: true,
    setupFiles: touch ? ['./early-notes.ts'] : [],
    sequence: { hooks: process.env.FIXTURE_HOOKS ?? 'stack' },
    coverage: {
      enabled: true,
      provider: 'istanbul',
      include: manifest.gates.map((gate) => gate.path),
      reporter: touch ? ['text', 'json'] : ['text'],
      reportsDirectory: touch ? path.join(touch, 'coverage') : 'coverage',
      thresholds: { perFile: true, statements: 100, branches: 100, functions: 100, lines: 100 },
    },
  },
};
`;
  const EARLY_NOTES = `import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, expect } from 'vitest';

const directory = process.env.TEST_GATES_TOUCH_DIR as string;
fs.mkdirSync(path.join(directory, 'specs'), { recursive: true });
fs.writeFileSync(
  path.join(directory, 'run.json'),
  JSON.stringify({ runner: 'vitest', version: '3.2.7', provider: 'istanbul', pool: 'forks', isolate: true, projects: 1, problem: null })
);
afterAll(() => {
  const spec = expect.getState().testPath as string;
  const coverage = (globalThis as any).__VITEST_COVERAGE__ ?? {};
  const files = Object.fromEntries(
    Object.entries(coverage).map(([file, counters]: [string, any]) => [
      file,
      { s: Object.values(counters.s), f: Object.values(counters.f), b: Object.values(counters.b).flat() },
    ])
  );
  const name = createHash('sha256').update(spec).digest('hex') + '.json';
  fs.writeFileSync(path.join(directory, 'specs', name), JSON.stringify({ spec, files }));
});
`;
  const gateFile = (name: string) =>
    `export function ${name}(value: number): number {\n  return value;\n}\n`;
  const specFile = (name: string, extra = '') =>
    "import { afterAll, beforeAll, expect, it } from 'vitest';\n" +
    `import { ${name} } from './${name}';\n${extra}` +
    `it('returns the value', () => {\n  expect(${name}(1)).toBe(1);\n});\n`;
  const names = ['first', 'second', 'third', 'late'];

  function fixture(lateCall: string): string {
    const dir = project({
      'package.json': { name: 'early-notes-fixture', private: true, type: 'module' },
      'vitest.gates.config.ts': CONFIG,
      'early-notes.ts': EARLY_NOTES,
      'test-gates.json': {
        gates: names.map((name) => ({ path: `src/${name}.ts`, decides: 'd', impact: 'i' })),
        candidates: [],
        settings: {
          gateCommand: [
            'node',
            'run-gate.cjs',
            'vitest',
            'run',
            '--config',
            'vitest.gates.config.ts',
          ],
        },
      },
      'run-gate.cjs':
        "const { spawnSync } = require('node:child_process');\n" +
        "require('node:fs').appendFileSync('runs.log', 'run\\n');\n" +
        'const [program, ...args] = process.argv.slice(2);\n' +
        "const result = spawnSync(require('node:path').join('node_modules', '.bin', program), args, { stdio: 'inherit' });\n" +
        'process.exit(result.status ?? 1);\n',
      ...Object.fromEntries(
        names.flatMap((name) => [
          [`src/${name}.ts`, gateFile(name)],
          [
            `src/${name}.spec.ts`,
            specFile(name, name === 'first' ? `import { late } from './late';\n${lateCall}` : ''),
          ],
        ])
      ),
    });
    fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
    return dir;
  }
  const runs = (dir: string) => {
    const count = fs.readFileSync(path.join(dir, 'runs.log'), 'utf8').trim().split('\n').length;
    fs.rmSync(path.join(dir, 'runs.log'));
    return count;
  };
  const NOT_HELD =
    '  ✗ src/late.ts: the gate passed although the spec of src/late.ts was left out. The gate does not measure this file (does the gate config honor TEST_GATES_EXCLUDE_SPEC?)';
  const REFUSED =
    'test-gates selfcheck: a run of the gate command for every gate (the notes of the specs do not add up to what the runner counted for src/late.ts)\n';

  it.each([
    [
      'a cleanup function returned by beforeAll',
      'beforeAll(() => () => {\n  late(1);\n});\n',
      'stack',
    ],
    [
      'the afterAll of the spec, with the hooks in the order written',
      'afterAll(() => {\n  late(1);\n});\n',
      'list',
    ],
  ])(
    'refuses the notes when another spec covers a gate in %s',
    { timeout: 300_000 },
    async (_name, lateCall, hooks) => {
      const dir = fixture(lateCall);
      const env = { FIXTURE_HOOKS: hooks };
      const perGate = await testGatesAsync(['selfcheck', '--dir', dir], env);
      expect(perGate.stderr).toContain(NOT_HELD);
      expect(perGate.status).toBe(1);
      expect(runs(dir)).toBe(4);

      // The spec of `first` covers `late` after its note was written, so the notes say that
      // only its own spec touches `late`. The runner counted two calls, the notes have one.
      const shared = await testGatesAsync(['selfcheck', '--quick', '--dir', dir], env);
      expect(shared.stdout).toBe(REFUSED + perGate.stdout);
      expect(shared.stderr).toContain(NOT_HELD);
      expect(shared.status).toBe(1);
      expect(runs(dir)).toBe(1 + 4);
    }
  );

  it(
    'accepts notes taken that way when nothing runs after them',
    { timeout: 300_000 },
    async () => {
      const dir = fixture('');
      const shared = await testGatesAsync(['selfcheck', '--quick', '--dir', dir]);
      expect(shared.stdout).not.toContain('a run of the gate command for every gate');
      expect(shared.status).toBe(0);
      expect(runs(dir)).toBe(2);
    }
  );
});
