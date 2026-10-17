import { describe, expect, it } from 'vitest';
import {
  cleanHold,
  jobFlags,
  jobsPlan,
  jobsRefused,
  knownCommand,
  reachesOutside,
  type LoadedFile,
  workerFlags,
} from './jobs';

describe('knownCommand', () => {
  const CONFIG = ['--config', 'gates.config.js'];

  it('knows jest and "vitest run" with a gate config', () => {
    expect(knownCommand('jest', CONFIG)).toEqual({ runner: 'jest' });
    expect(knownCommand('jest', ['--config=gates.config.js'])).toEqual({ runner: 'jest' });
    expect(knownCommand('jest', ['-c', 'gates.config.js'])).toEqual({ runner: 'jest' });
    expect(knownCommand('vitest', ['run', ...CONFIG])).toEqual({ runner: 'vitest' });
    expect(knownCommand('vitest', ['run', '-c=gates.config.ts'])).toEqual({ runner: 'vitest' });
  });

  it.each([
    ['jest', ['--runInBand']],
    ['jest', ['-i']],
    ['jest', ['--ci']],
    ['jest', ['--maxWorkers=2']],
    ['jest', ['--maxWorkers', '50%']],
    ['jest', ['-w', '12']],
    ['jest', ['-w=1']],
    ['vitest', ['--no-file-parallelism']],
    ['vitest', ['--fileParallelism=false']],
    ['vitest', ['--pool=forks']],
    ['vitest', ['--pool=threads']],
    ['vitest', ['--maxWorkers=4']],
    ['vitest', ['--minWorkers', '1']],
  ] as const)('knows %s with %j, before and after the config', (runner, options) => {
    const head = runner === 'vitest' ? ['run'] : [];
    expect(knownCommand(runner, [...head, ...options, ...CONFIG])).toEqual({ runner });
    expect(knownCommand(runner, [...head, ...CONFIG, ...options])).toEqual({ runner });
  });

  it('names a program that is not a runner', () => {
    expect(knownCommand('node', ['run-gate.cjs', 'jest', ...CONFIG])).toEqual({ stray: 'node' });
    expect(knownCommand('npx', ['vitest', 'run', ...CONFIG])).toEqual({ stray: 'npx' });
  });

  it('wants "run" as the first word after vitest, and not after jest', () => {
    expect(knownCommand('vitest', CONFIG)).toEqual({ stray: '--config' });
    expect(knownCommand('vitest', [...CONFIG, 'run'])).toEqual({ stray: '--config' });
    expect(knownCommand('vitest', [])).toEqual({ stray: 'vitest without "run"' });
    expect(knownCommand('jest', ['run', ...CONFIG])).toEqual({ stray: 'run' });
  });

  it.each([
    ['jest', ['--coverageDirectory=out'], '--coverageDirectory=out'],
    ['jest', ['--coverageDirectory', 'out'], '--coverageDirectory'],
    ['jest', ['--cacheDirectory=out'], '--cacheDirectory=out'],
    ['jest', ['--no-file-parallelism'], '--no-file-parallelism'],
    ['jest', ['--minWorkers=1'], '--minWorkers=1'],
    ['jest', ['--pool=forks'], '--pool=forks'],
    ['jest', ['src/fee.spec.js'], 'src/fee.spec.js'],
    ['jest', ['--maxWorkers=two'], '--maxWorkers=two'],
    ['jest', ['--maxWorkers=2x'], '--maxWorkers=2x'],
    ['jest', ['--maxWorkers=x2'], '--maxWorkers=x2'],
    ['jest', ['--maxWorkers=%'], '--maxWorkers=%'],
    ['jest', ['--maxWorkers=5%%'], '--maxWorkers=5%%'],
    ['jest', ['--maxWorkers='], '--maxWorkers='],
    ['jest', ['--maxWorkers'], '--maxWorkers'],
    ['jest', ['--runInBand=1'], '--runInBand=1'],
    ['vitest', ['--coverage.reportsDirectory=out'], '--coverage.reportsDirectory=out'],
    ['vitest', ['--runInBand'], '--runInBand'],
    ['vitest', ['-w', '2'], '-w'],
    ['vitest', ['--pool=vmThreads'], '--pool=vmThreads'],
    ['vitest', ['--fileParallelism=true'], '--fileParallelism=true'],
    ['vitest', ['--reporter=dot'], '--reporter=dot'],
  ] as const)('does not know %s with %j', (runner, options, stray) => {
    const head = runner === 'vitest' ? ['run'] : [];
    expect(knownCommand(runner, [...head, ...CONFIG, ...options])).toEqual({ stray });
  });

  it('wants exactly one gate config', () => {
    expect(knownCommand('jest', [])).toEqual({ stray: 'no --config' });
    expect(knownCommand('jest', ['--runInBand'])).toEqual({ stray: 'no --config' });
    expect(knownCommand('vitest', ['run'])).toEqual({ stray: 'no --config' });
    expect(knownCommand('jest', [...CONFIG, ...CONFIG])).toEqual({ stray: 'two --config' });
    expect(knownCommand('jest', [...CONFIG, '-c=other.js'])).toEqual({ stray: 'two --config' });
    expect(knownCommand('jest', ['--config'])).toEqual({ stray: '--config' });
  });

  it('takes the word after an option as its value, whatever it is', () => {
    // `--runInBand` is the name of the config here, so no option is left.
    expect(knownCommand('jest', ['--config', '--runInBand'])).toEqual({ runner: 'jest' });
    expect(knownCommand('jest', ['--maxWorkers', '--config', 'x'])).toEqual({
      stray: '--maxWorkers',
    });
  });
});

describe('jobFlags', () => {
  it('gives the coverage tool and the cache of the runner a place in the directory', () => {
    expect(jobFlags('jest', '/tmp/line-0')).toEqual([
      '--coverageDirectory=/tmp/line-0/coverage',
      '--cacheDirectory=/tmp/line-0/cache',
    ]);
    expect(jobFlags('vitest', '/tmp/line-1')).toEqual([
      '--coverage.reportsDirectory=/tmp/line-1/coverage',
      '--no-cache',
    ]);
  });
});

describe('workerFlags', () => {
  const CONFIG = ['--config', 'gates.config.js'];
  const flags = (input: Partial<Parameters<typeof workerFlags>[0]> = {}) =>
    workerFlags({
      runner: 'jest',
      args: CONFIG,
      configSource: 'export default createJestGatesConfig();',
      lines: 4,
      cores: 12,
      ...input,
    });

  it('shares the cores out between the runs at the same time', () => {
    expect(flags()).toEqual(['--maxWorkers=3']);
    expect(flags({ cores: 15 })).toEqual(['--maxWorkers=3']);
    expect(flags({ cores: 16 })).toEqual(['--maxWorkers=4']);
    expect(flags({ lines: 2 })).toEqual(['--maxWorkers=6']);
    expect(flags({ lines: 3, cores: 2 })).toEqual(['--maxWorkers=1']);
    expect(flags({ lines: 12 })).toEqual(['--maxWorkers=1']);
    expect(flags({ runner: 'vitest', args: ['run', ...CONFIG] })).toEqual(['--maxWorkers=3']);
  });

  it('adds nothing to a run that is alone', () => {
    expect(flags({ lines: 1 })).toEqual([]);
    expect(flags({ lines: 1, cores: 1 })).toEqual([]);
  });

  it('keeps an empty config and one that cannot be read as they are', () => {
    expect(flags({ configSource: '' })).toEqual(['--maxWorkers=3']);
    expect(flags({ configSource: null })).toEqual(['--maxWorkers=3']);
  });

  it.each([
    ['jest', ['--runInBand']],
    ['jest', ['-i']],
    ['jest', ['--maxWorkers=2']],
    ['jest', ['--maxWorkers', '50%']],
    ['jest', ['-w', '12']],
    ['jest', ['-w=1']],
    ['vitest', ['--no-file-parallelism']],
    ['vitest', ['--fileParallelism=false']],
    ['vitest', ['--maxWorkers=4']],
    ['vitest', ['--minWorkers', '1']],
  ] as const)('leaves the workers of %s with %j as they are', (runner, options) => {
    const head = runner === 'vitest' ? ['run'] : [];
    expect(flags({ runner, args: [...head, ...CONFIG, ...options] })).toEqual([]);
    expect(flags({ runner, args: [...head, ...options, ...CONFIG] })).toEqual([]);
  });

  it.each([
    ['jest', ['--ci']],
    ['vitest', ['--pool=forks']],
    ['vitest', ['--pool=threads']],
    // An option of the other runner.
    ['jest', ['--no-file-parallelism']],
    ['vitest', ['-i']],
  ] as const)('still shares the cores out for %s with %j', (runner, options) => {
    const head = runner === 'vitest' ? ['run'] : [];
    expect(flags({ runner, args: [...head, ...CONFIG, ...options] })).toEqual(['--maxWorkers=3']);
  });

  it.each([
    'maxWorkers',
    'minWorkers',
    'maxThreads',
    'minThreads',
    'maxForks',
    'minForks',
    'fileParallelism',
    'singleThread',
    'singleFork',
  ])('leaves the workers as they are when the gate config names %s', (word) => {
    expect(
      flags({ configSource: `export default createJestGatesConfig({ ${word}: 2 });` })
    ).toEqual([]);
  });
});

const file = (source: string, imports: LoadedFile['imports'] = []): LoadedFile => ({
  path: 'src/fee.spec.ts',
  source,
  imports,
});
const QUIET_SPEC =
  "import { fee } from './fee';\nit('charges', () => {\n  expect(fee(2)).toBe(6);\n});\n";

describe('reachesOutside', () => {
  it('finds nothing in a spec that only calls its gate', () => {
    expect(reachesOutside(file(QUIET_SPEC), [])).toBeNull();
    expect(reachesOutside(file(''), [])).toBeNull();
  });

  it.each([
    ['process.env.HOME', 'process'],
    ['process?.env', 'process'],
    ["process['env']", 'process'],
    ['process.hrtime.bigint()', 'process'],
    ['globalThis.started = true;', 'globalThis'],
    ['global.started = true;', 'global'],
    ["global['started'] = true;", 'global'],
    ['import.meta.env.MODE', 'import.meta.env'],
    ['const at = Date.now();', 'Date.now'],
    ['const at = new Date();', 'Date()'],
    ['const at = Date();', 'Date()'],
    ['performance.now()', 'performance.now'],
    ['await new Promise((done) => setTimeout(done, 10));', 'setTimeout'],
    ['setInterval(tick, 10);', 'setInterval'],
    ['setImmediate(tick);', 'setImmediate'],
    ['await vi.waitFor(() => ready);', 'waitFor'],
    ['await vi.waitUntil(() => ready);', 'waitUntil'],
    ['await expect.poll(() => count).toBe(1);', 'expect.poll'],
    ['jest.retryTimes(2);', 'retryTimes'],
    ["it('x', { retry: 2 }, () => {});", 'retry'],
    ["await fetch('http://localhost:3000');", 'fetch'],
    ['new WebSocket(url);', 'WebSocket'],
    ['new XMLHttpRequest();', 'XMLHttpRequest'],
    ['navigator.hardwareConcurrency', 'navigator'],
    ['Atomics.wait(view, 0, 0, 10);', 'Atomics'],
    ['new WeakRef(value);', 'WeakRef'],
    ['new FinalizationRegistry(done);', 'FinalizationRegistry'],
    ["eval('1');", 'eval'],
    ["new Function('return 1');", 'Function'],
  ])('names what %j uses', (line, what) => {
    expect(reachesOutside(file(`${QUIET_SPEC}${line}\n`), ['anything'])).toBe(`uses ${what}`);
  });

  it('finds a use that is spread over lines', () => {
    expect(reachesOutside(file('const at = Date\n  .now();'), [])).toBe('uses Date.now');
    expect(reachesOutside(file('process\n  .env'), [])).toBe('uses process');
    expect(reachesOutside(file('new Date(\n)'), [])).toBe('uses Date()');
  });

  it('takes a date that is given for what it is', () => {
    expect(reachesOutside(file("const at = new Date('2024-01-01');"), [])).toBeNull();
    expect(reachesOutside(file('const at = new Date(2024, 0, 1);'), [])).toBeNull();
  });

  it.each([
    'require(name)',
    'await import(name)',
    'require(`./${name}`)',
    'import( name )',
    'const load = require;',
    'load(require)',
    "require.call(null, 'fs')",
    'require.cache',
    'require.resolved',
    'x = require',
    "const all = import.meta.glob('./*.ts', { eager: true })",
  ])('does not take a module whose name is computed: %s', (line) => {
    expect(reachesOutside(file(line), [])).toBe('loads a module whose name is computed');
  });

  it.each([
    "require('./fee')",
    'await import("./fee")',
    "jest.requireActual('./fee')",
    "require.resolve('./fee')",
    'const required = 1;',
    "it('requires a name', () => {});",
    'const require$ = 1;',
    'const requirement = prerequired;',
  ])('takes a module that is named: %s', (line) => {
    expect(reachesOutside(file(line), [])).toBeNull();
  });

  it.each(['fs', 'node:fs', 'node:fs/promises', 'net', 'node:child_process', 'os', 'path'])(
    'does not take the built-in module %s',
    (specifier) => {
      expect(reachesOutside(file('', [{ specifier, builtin: true }]), [])).toBe(
        `imports ${specifier}`
      );
      // a built-in module is not trusted by a name
      expect(reachesOutside(file('', [{ specifier, builtin: true }]), [specifier])).toBe(
        `imports ${specifier}`
      );
    }
  );

  it('takes the packages of the runners, and their subpaths', () => {
    for (const specifier of ['vitest', 'vitest/config', '@jest/globals']) {
      expect(reachesOutside(file('', [{ specifier, builtin: false }]), [])).toBeNull();
    }
  });

  it('does not take another package, unless the project vouches for it', () => {
    const imports = [
      { specifier: 'vitest', builtin: false },
      { specifier: 'date-fns/locale', builtin: false },
    ];
    expect(reachesOutside(file('', imports), [])).toBe(
      'imports the package date-fns/locale, which is not looked into'
    );
    expect(reachesOutside(file('', imports), ['zod'])).toBe(
      'imports the package date-fns/locale, which is not looked into'
    );
    expect(reachesOutside(file('', imports), ['zod', 'date-fns'])).toBeNull();
    expect(reachesOutside(file('', imports), ['date-fns/locale'])).toBeNull();
    // a name that only begins the same
    expect(reachesOutside(file('', [{ specifier: 'vitest-extra', builtin: false }]), [])).toBe(
      'imports the package vitest-extra, which is not looked into'
    );
    expect(reachesOutside(file('', [{ specifier: 'date-fns', builtin: false }]), ['date'])).toBe(
      'imports the package date-fns, which is not looked into'
    );
    // a package that is called like a built-in module is a package
    expect(reachesOutside(file('', [{ specifier: 'path', builtin: false }]), [])).toBe(
      'imports the package path, which is not looked into'
    );
  });

  it('names the text before the import', () => {
    expect(
      reachesOutside(file('Date.now(); require(name);', [{ specifier: 'fs', builtin: true }]), [])
    ).toBe('uses Date.now');
    expect(reachesOutside(file('require(name);', [{ specifier: 'fs', builtin: true }]), [])).toBe(
      'loads a module whose name is computed'
    );
  });
});

describe('jobsRefused', () => {
  const VITEST = "export default createVitestGatesConfig({ coverageProvider: 'istanbul' });";
  const JEST = 'module.exports = createJestGatesConfig({ rootDir: __dirname });';
  const ask = (changes: Partial<Parameters<typeof jobsRefused>[0]> = {}) =>
    jobsRefused({
      failurePattern: null,
      command: { runner: 'vitest' },
      configSource: VITEST,
      ...changes,
    });
  const PATTERN =
    'with settings.selfcheck.failurePattern, a run that was disturbed cannot be told from one that was not';
  const COMMAND =
    'the gate command is not known to keep runs at the same time apart: only jest or "vitest run" with --config and options for the number of workers is (found: --coverage)';

  it('lets the controls of a known gate command and config run at the same time', () => {
    expect(ask()).toBeNull();
    expect(ask({ command: { runner: 'jest' }, configSource: JEST })).toBeNull();
    expect(ask({ failurePattern: '' })).toBeNull();
  });

  it('refuses with a failure pattern of the project, before anything else', () => {
    expect(ask({ failurePattern: 'threshold.*{gate}' })).toBe(PATTERN);
    expect(ask({ failurePattern: 'x', command: { stray: '--coverage' } })).toBe(PATTERN);
  });

  it('refuses a gate command with a word that is not known, before the config', () => {
    expect(ask({ command: { stray: '--coverage' } })).toBe(COMMAND);
    expect(ask({ command: { stray: '--coverage' }, configSource: null })).toBe(COMMAND);
  });

  it('refuses a gate config that is not built with the helper of the runner', () => {
    expect(ask({ configSource: null })).toBe(
      'the gate config does not use createVitestGatesConfig'
    );
    expect(ask({ configSource: JEST })).toBe(
      'the gate config does not use createVitestGatesConfig'
    );
    expect(ask({ command: { runner: 'jest' } })).toBe(
      'the gate config does not use createJestGatesConfig'
    );
  });
});

describe('jobsPlan', () => {
  const at = (path: string, source: string, imports: LoadedFile['imports'] = []): LoadedFile => ({
    path,
    source,
    imports,
  });
  const FS = [{ specifier: 'node:fs', builtin: true }];
  // Three gates, each with a spec that calls it with fixed values.
  const files = [
    at('src/fee.ts', 'export const fee = (x) => x * 3;'),
    at('src/fee.spec.ts', QUIET_SPEC),
    at('src/tax.ts', 'export const tax = (x) => x;'),
    at('src/tax.spec.ts', "import { tax } from './tax';"),
    at('src/age.ts', 'export const age = 1;'),
    at('src/age.spec.ts', "import { age } from './age';"),
    at('src/support/lock.ts', '', FS),
  ];
  const gates = ['fee', 'tax', 'age'].map((name) => ({
    path: `src/${name}.ts`,
    spec: `src/${name}.spec.ts`,
  }));
  const root = (spec: string | null, loaded: string[], lost: string | null = null) => ({
    spec,
    files: loaded,
    lost,
  });
  const quiet = [
    root(null, []),
    root('src/fee.spec.ts', ['src/fee.spec.ts', 'src/fee.ts']),
    root('src/tax.spec.ts', ['src/tax.spec.ts', 'src/tax.ts']),
    root('src/age.spec.ts', ['src/age.spec.ts', 'src/age.ts']),
  ];
  const plan = (
    roots: Parameters<typeof jobsPlan>[0]['roots'],
    changes: Partial<Parameters<typeof jobsPlan>[0]> = {}
  ) => jobsPlan({ gates, files, roots, trusted: [], ...changes });
  const ALL = { atOnce: ['src/fee.ts', 'src/tax.ts', 'src/age.ts'], alone: [], causes: [] };
  const LOCK = 'src/support/lock.ts imports node:fs';

  it('finds a gate written with ./ in what a spec reaching outside loads', () => {
    const roots = [
      ...quiet.slice(0, 3),
      root('src/age.spec.ts', [
        'src/age.spec.ts',
        'src/age.ts',
        'src/support/lock.ts',
        'src/fee.ts',
      ]),
    ];
    const dotted = gates.map((gate) => ({ ...gate, path: `./${gate.path}` }));
    expect(plan(roots, { gates: dotted }).alone).toEqual(['./src/fee.ts']);
  });

  it('lets every control of specs that only call their own gate run next to others', () => {
    expect(plan(quiet)).toEqual(ALL);
    expect(plan([])).toEqual(ALL);
  });

  it('lets the control of a gate run next to others when only its own spec reaches outside', () => {
    // The usual spec of a gate that needs a clock or a file: it loads no other gate, so it
    // cannot cover one, and it is left out of the run of its own gate.
    const roots = [
      ...quiet.slice(0, 2),
      root('src/tax.spec.ts', ['src/tax.spec.ts', 'src/tax.ts', 'src/support/lock.ts']),
      quiet[3]!,
    ];
    expect(plan(roots)).toEqual(ALL);
  });

  it('runs on their own the controls of the gates that another spec reaching outside loads', () => {
    const roots = [
      ...quiet.slice(0, 3),
      root('src/age.spec.ts', [
        'src/age.spec.ts',
        'src/tax.ts',
        'src/age.ts',
        'src/support/lock.ts',
        'src/fee.ts',
      ]),
    ];
    expect(plan(roots)).toEqual({
      atOnce: ['src/age.ts'],
      alone: ['src/fee.ts', 'src/tax.ts'],
      causes: [
        {
          gates: ['src/fee.ts', 'src/tax.ts'],
          reason: `loaded by src/age.spec.ts, in which ${LOCK}`,
        },
      ],
    });
  });

  it('gives every spec that keeps a control apart, and every file that reaches outside in it', () => {
    const roots = [
      root(null, []),
      root('src/fee.spec.ts', ['src/fee.spec.ts', 'src/fee.ts']),
      root('src/tax.spec.ts', ['src/tax.spec.ts', 'src/fee.ts', 'src/support/lock.ts']),
      root('src/age.spec.ts', ['src/age.spec.ts', 'src/fee.ts', 'src/late.ts', 'src/x.ts']),
    ];
    const late = at('src/late.ts', 'Date.now(); setTimeout(() => {});', FS);
    const x = at('src/x.ts', 'globalThis.x = 1;');
    expect(plan(roots, { files: [...files, late, x] })).toEqual({
      atOnce: ['src/tax.ts', 'src/age.ts'],
      alone: ['src/fee.ts'],
      causes: [
        { gates: ['src/fee.ts'], reason: `loaded by src/tax.spec.ts, in which ${LOCK}` },
        {
          gates: ['src/fee.ts'],
          reason:
            'loaded by src/age.spec.ts, in which src/late.ts uses Date.now; src/x.ts uses globalThis',
        },
      ],
    });
  });

  it('runs every control on its own when a file the gate config names reaches outside', () => {
    const roots = [root(null, ['test/setup.ts']), ...quiet.slice(1)];
    const setup = at('test/setup.ts', 'process.env.TZ = "UTC";');
    expect(plan(roots, { files: [...files, setup] })).toEqual({
      atOnce: [],
      alone: ['src/fee.ts', 'src/tax.ts', 'src/age.ts'],
      causes: [
        {
          gates: ['src/fee.ts', 'src/tax.ts', 'src/age.ts'],
          reason: 'run with what the gate config names, in which test/setup.ts uses process',
        },
      ],
    });
    // A setup file that only computes, and one that loads a gate, keep nothing apart.
    const quietSetup = at('test/setup.ts', "import { fee } from '../src/fee';");
    expect(
      plan([root(null, ['test/setup.ts', 'src/fee.ts']), ...quiet.slice(1)], {
        files: [...files, quietSetup],
      })
    ).toEqual(ALL);
  });

  it('runs every other control on its own when what a spec loads cannot be followed', () => {
    const lost = './gone (imported by src/age.spec.ts)';
    const roots = [...quiet.slice(0, 3), root('src/age.spec.ts', ['src/age.spec.ts'], lost)];
    expect(plan(roots)).toEqual({
      atOnce: ['src/age.ts'],
      alone: ['src/fee.ts', 'src/tax.ts'],
      causes: [
        {
          gates: ['src/fee.ts', 'src/tax.ts'],
          reason: `maybe loaded by src/age.spec.ts, in which ${lost} cannot be followed`,
        },
      ],
    });
    // In the files the gate config names: every control.
    expect(plan([root(null, [], lost), ...quiet.slice(1)]).causes).toEqual([
      {
        gates: ['src/fee.ts', 'src/tax.ts', 'src/age.ts'],
        reason: `run with what the gate config names, in which ${lost} cannot be followed`,
      },
    ]);
  });

  it('runs every other control on its own when a spec loads a module whose name is computed', () => {
    const roots = [
      ...quiet.slice(0, 3),
      root('src/age.spec.ts', ['src/age.spec.ts', 'src/age.ts', 'src/load.ts']),
    ];
    const cause = (source: string) =>
      plan(roots, { files: [...files, at('src/load.ts', source)] }).causes;
    const gates = ['src/fee.ts', 'src/tax.ts'];
    expect(cause('const x = require(name);')).toEqual([
      {
        gates,
        reason:
          'maybe loaded by src/age.spec.ts, in which src/load.ts loads a module whose name is computed',
      },
    ]);
    // Said also when the file uses something else first.
    expect(cause('Date.now(); const x = require (\n name);')).toEqual([
      {
        gates,
        reason:
          'maybe loaded by src/age.spec.ts, in which src/load.ts uses Date.now; src/load.ts loads a module whose name is computed',
      },
    ]);
  });

  it('does not count a spec that the gate shares with the control', () => {
    // Two gates with one spec: the control of either leaves that spec out.
    const shared = [
      { path: 'src/fee.ts', spec: 'src/both.spec.ts' },
      { path: 'src/tax.ts', spec: 'src/both.spec.ts' },
    ];
    const roots = [
      root(null, []),
      root('src/both.spec.ts', [
        'src/both.spec.ts',
        'src/fee.ts',
        'src/tax.ts',
        'src/support/lock.ts',
      ]),
    ];
    expect(plan(roots, { gates: shared })).toEqual({
      atOnce: ['src/fee.ts', 'src/tax.ts'],
      alone: [],
      causes: [],
    });
  });

  it('trusts the packages the project vouches for, and skips a file it was not given', () => {
    const zod = at('src/schema.ts', '', [{ specifier: 'zod', builtin: false }]);
    const roots = [
      ...quiet.slice(0, 3),
      root('src/age.spec.ts', ['src/age.spec.ts', 'src/schema.ts', 'src/fee.ts', 'src/unread.ts']),
    ];
    expect(plan(roots, { files: [...files, zod] }).causes).toEqual([
      {
        gates: ['src/fee.ts'],
        reason:
          'loaded by src/age.spec.ts, in which src/schema.ts imports the package zod, which is not looked into',
      },
    ]);
    expect(plan(roots, { files: [...files, zod], trusted: ['zod'] })).toEqual(ALL);
  });
});

describe('cleanHold', () => {
  const GATE_PATH = 'src/fee.ts';
  const others = ['src/tax.ts', 'lib/src/fee.ts'];
  const VITEST_LINE =
    'ERROR: Coverage for lines (0%) does not meet global threshold (100%) for src/fee.ts';
  const JEST_LINE =
    'Jest: Coverage for statements (0%) does not meet "/work/app/src/fee.ts" threshold (100%)';
  const VITEST_SUM = ' Test Files  4 passed (4)\n      Tests  20 passed (20)\n';
  const JEST_SUM = 'Test Suites: 4 passed, 4 total\nTests:       20 passed, 20 total\n';
  const clean = (changes: Partial<Parameters<typeof cleanHold>[0]> = {}) =>
    cleanHold({
      held: true,
      signal: null,
      output: `${VITEST_SUM}${VITEST_LINE}\n`,
      runner: 'vitest',
      specs: 4,
      gatePath: GATE_PATH,
      others,
      names: [],
      ...changes,
    });
  const jest = (output: string) => clean({ runner: 'jest', output });

  it('takes a control that held and whose run says that everything else passed', () => {
    expect(clean()).toBe(true);
    expect(jest(`PASS src/tax.spec.ts\n${JEST_LINE}\n${JEST_SUM}Ran all test suites.\n`)).toBe(
      true
    );
    // every metric of the same gate
    expect(
      clean({
        output: `${VITEST_SUM}${VITEST_LINE}\n${VITEST_LINE.replace('lines', 'branches')}\n`,
      })
    ).toBe(true);
    expect(jest(`${JEST_SUM}Jest: Coverage data for /work/app/src/fee.ts was not found.\n`)).toBe(
      true
    );
    // lines that end in a carriage return, and a run in colour
    expect(clean({ output: `${VITEST_SUM}${VITEST_LINE}\n`.replace(/\n/g, '\r\n') })).toBe(true);
    expect(
      clean({
        output: ` \u001b[2mTest Files \u001b[22m \u001b[1m\u001b[32m4 passed\u001b[39m\u001b[22m\u001b[90m (4)\u001b[39m\n\u001b[2m      Tests \u001b[22m \u001b[1m\u001b[32m20 passed\u001b[39m\u001b[22m\u001b[90m (20)\u001b[39m\n${VITEST_LINE}\n`,
      })
    ).toBe(true);
  });

  it('does not take a control that did not hold, or a run that ended by a signal', () => {
    expect(clean({ held: false })).toBe(false);
    expect(clean({ signal: 'SIGKILL' })).toBe(false);
    expect(clean({ held: false, signal: 'SIGTERM' })).toBe(false);
  });

  it.each([
    ['no summary', ''],
    ['only the files', ' Test Files  4 passed (4)\n'],
    ['only the tests', '      Tests  20 passed (20)\n'],
    ['a failed file', ' Test Files  1 failed | 3 passed (4)\n      Tests  20 passed (20)\n'],
    ['a skipped file', ' Test Files  4 passed | 1 skipped (5)\n      Tests  20 passed (20)\n'],
    ['a file too few', ' Test Files  3 passed (3)\n      Tests  20 passed (20)\n'],
    ['a file too many', ' Test Files  5 passed (5)\n      Tests  20 passed (20)\n'],
    ['files that are not all', ' Test Files  4 passed (5)\n      Tests  20 passed (20)\n'],
    ['more files than all', ' Test Files  5 passed (4)\n      Tests  20 passed (20)\n'],
    ['a skipped test', ' Test Files  4 passed (4)\n      Tests  19 passed | 1 skipped (20)\n'],
    ['tests that are not all', ' Test Files  4 passed (4)\n      Tests  19 passed (20)\n'],
    ['no test', ' Test Files  4 passed (4)\n      Tests  no tests\n'],
    ['a count that is no number', ' Test Files  4 passed (4)\n      Tests  x passed (x)\n'],
    ['a count with more to it', ' Test Files  4 passed (4)\n      Tests  2x passed (2x)\n'],
    ['a count that begins late', ' Test Files  4 passed (4)\n      Tests  x2 passed (x2)\n'],
    ['the files twice', ` Test Files  4 passed (4)\n${VITEST_SUM}`],
    ['the tests twice', `${VITEST_SUM}      Tests  20 passed (20)\n`],
    ['the summary of Jest', JEST_SUM],
    ['words after the files', ' Test Files  4 passed (4) or so\n      Tests  20 passed (20)\n'],
    ['words after the tests', ' Test Files  4 passed (4)\n      Tests  20 passed (20) or so\n'],
  ])('does not take a run of Vitest with %s', (_name, summary) => {
    expect(clean({ output: `${summary}${VITEST_LINE}\n` })).toBe(false);
  });

  it.each([
    ['no summary', ''],
    ['only the suites', 'Test Suites: 4 passed, 4 total\n'],
    ['only the tests', 'Tests:       20 passed, 20 total\n'],
    ['a failed suite', 'Test Suites: 1 failed, 3 passed, 4 total\nTests: 20 passed, 20 total\n'],
    ['a suite too few', 'Test Suites: 3 passed, 3 total\nTests:       20 passed, 20 total\n'],
    [
      'suites that did not all run',
      'Test Suites: 4 passed, 4 of 5 total\nTests: 2 passed, 2 total\n',
    ],
    ['a skipped test', 'Test Suites: 4 passed, 4 total\nTests: 1 skipped, 19 passed, 20 total\n'],
    ['a test left', 'Test Suites: 4 passed, 4 total\nTests:       19 passed, 20 total\n'],
    ['the summary of Vitest', VITEST_SUM],
  ])('does not take a run of Jest with %s', (_name, summary) => {
    expect(jest(`${summary}${JEST_LINE}\n`)).toBe(false);
  });

  it('reads the summary at the start of a line only', () => {
    expect(
      clean({
        output: `seen: Test Files  9 passed (9)\nseen: Tests  1 passed (1)\n${VITEST_SUM}${VITEST_LINE}\n`,
      })
    ).toBe(true);
    expect(
      jest(
        `seen: Test Suites: 9 passed, 9 total\nseen: Tests: 1 passed, 1 total\n${JEST_SUM}${JEST_LINE}\n`
      )
    ).toBe(true);
  });

  it('does not take a run that reports the threshold of another gate as well', () => {
    const also = (line: string) => clean({ output: `${VITEST_SUM}${VITEST_LINE}\n${line}\n` });
    expect(also(VITEST_LINE.replace('src/fee.ts', 'src/tax.ts'))).toBe(false);
    // a line that names this gate only as a part of the path of another
    expect(also(VITEST_LINE.replace('src/fee.ts', 'lib/src/fee.ts'))).toBe(false);
    // a threshold line that names no gate
    expect(also('ERROR: Coverage for lines (90%) does not meet global threshold (100%)')).toBe(
      false
    );
    expect(also('Jest: Coverage data for /work/app/src/tax.ts was not found.')).toBe(false);
    expect(also('JEST: COVERAGE DATA FOR /work/app/src/tax.ts WAS NOT FOUND.')).toBe(false);
    expect(also('A THRESHOLD of src/tax.ts')).toBe(false);
  });

  it.each([
    ' FAIL  src/tax.spec.ts',
    'the run did fail',
    'it fails',
    'Tests:       1 failed, 19 passed, 20 total',
    '1 failing',
    'failure in worker',
    '2 failures',
    'Error: Test timed out in 5000ms.',
    'thrown: "Exceeded timeout of 5000 ms for a test.',
    '3 timeouts',
    'Test timed out',
    'Unhandled Rejection',
    'Uncaught exception',
    'TypeError: x is not a function',
    'Errors  1 error',
    '2 errors',
    'ERR_REQUIRE_ESM',
    'A worker process was terminated',
    'the process was killed',
    'the worker crashed',
    'aborted',
    '1 skipped',
    '2 todo',
    'retry x1',
    'retried once',
    '1 snapshot obsolete',
    'SIGKILL',
    'ended by SIGTERM',
    'SIGABRT',
    'SIGSEGV',
    'SIGINT',
    ' ✗ a test',
    ' × a test',
    ' ✕ a test',
    ' ✖ a test',
  ])('does not take a run that also says %j', (line) => {
    expect(clean({ output: `${VITEST_SUM}${line}\n${VITEST_LINE}\n` })).toBe(false);
    expect(clean({ output: `${VITEST_LINE}\n${VITEST_SUM}${line}` })).toBe(false);
  });

  it.each([
    ' ✓ src/tax.spec.ts (5 tests) 3ms',
    'PASS src/failsafe.spec.ts',
    'words that only look like it: failings, terrorist, signal, errant, skip',
    ' RUN  v3.2.7 /work/app',
    'File      | % Stmts | % Branch | % Funcs | % Lines | Uncovered Line #s',
  ])('takes a run with a line that says nothing of the kind: %j', (line) => {
    expect(clean({ output: `${line}\n${VITEST_SUM}${VITEST_LINE}\n` })).toBe(true);
  });

  it('does not read the names of the project as words of the runner', () => {
    const output = `${VITEST_SUM} ✓ src/errors.spec.ts (5 tests)\n RUN  /work/failed\n${VITEST_LINE}\n`;
    expect(clean({ output })).toBe(false);
    expect(clean({ output, names: ['src/errors.spec.ts'] })).toBe(false);
    expect(clean({ output, names: ['src/errors.spec.ts', '/work/failed'] })).toBe(true);
    // what stands next to a name is still read
    expect(
      clean({
        output: `${VITEST_SUM} FAIL src/errors.spec.ts\n${VITEST_LINE}\n`,
        names: ['src/errors.spec.ts'],
      })
    ).toBe(false);
    // and what a name stands in the middle of is not put together
    expect(
      clean({
        output: `${VITEST_SUM}absrc/errors.spec.tsorted\n${VITEST_LINE}\n`,
        names: ['src/errors.spec.ts'],
      })
    ).toBe(true);
    // every place a name stands in
    expect(
      clean({
        output: `${VITEST_SUM}src/errors.spec.ts and src/errors.spec.ts\n${VITEST_LINE}\n`,
        names: ['src/errors.spec.ts'],
      })
    ).toBe(true);
  });

  it('does not read a row of the coverage table', () => {
    const row = (cells: string) => clean({ output: `${VITEST_SUM}${cells}\n${VITEST_LINE}\n` });
    expect(row(' errors.ts |     100 |      100 |     100 |     100 |')).toBe(true);
    expect(row(' errors.ts |     100 |      100 |     100 | 100')).toBe(true);
    // fewer cells than the table has: a line of something else
    expect(row(' errors.ts |     100 |      100 | 100')).toBe(false);
    expect(row(' Test Files  1 failed | 3 passed (4)')).toBe(false);
  });
});
