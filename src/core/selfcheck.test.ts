import { describe, expect, it } from 'vitest';
import {
  EXCLUDE_ALL_ENV,
  EXCLUDE_ENV,
  excludedSpecs,
  judgeSelfcheck,
  accountedFor,
  minorOf,
  planControls,
  gateRunCaveat,
  gateRunRefused,
  affectedRefused,
  quickCaveat,
  quickRefused,
  selectControls,
  sharedRunPrecheck,
  unverifiedRun,
  unverifiedVersion,
  VERIFIED_RUNS,
} from './selfcheck';

const GATE = 'src/common/shipping-fee.ts';

// Real output lines of the two runners when a file misses its threshold.
const JEST_THRESHOLD =
  'Jest: "/work/app/src/common/shipping-fee.ts" coverage threshold for statements (100%) not met: 0%';
const JEST_NO_DATA = 'Jest: Coverage data for ./src/common/shipping-fee.ts was not found.';
const VITEST_THRESHOLD =
  'ERROR: Coverage for lines (0%) does not meet global threshold (100%) for src/common/shipping-fee.ts';

describe('judgeSelfcheck', () => {
  it('names the environment variable the gate config has to read', () => {
    expect(EXCLUDE_ENV).toBe('TEST_GATES_EXCLUDE_SPEC');
  });

  it.each([
    ['Jest threshold message', JEST_THRESHOLD],
    ['Jest missing coverage data', JEST_NO_DATA],
    ['Vitest threshold message', VITEST_THRESHOLD],
  ])('holds when the gate fails with a %s for the gate', (_name, line) => {
    expect(
      judgeSelfcheck({ status: 1, output: `PASS another.spec.ts\n${line}\n`, gatePath: GATE })
    ).toBeNull();
  });

  it('holds for any non-zero exit code', () => {
    expect(judgeSelfcheck({ status: 2, output: VITEST_THRESHOLD, gatePath: GATE })).toBeNull();
  });

  it('does not hold when the gate passes', () => {
    expect(judgeSelfcheck({ status: 0, output: JEST_THRESHOLD, gatePath: GATE })).toBe(
      'the gate passed although the spec of src/common/shipping-fee.ts was left out. The gate does not measure this file (does the gate config honor TEST_GATES_EXCLUDE_SPEC?)'
    );
  });

  it('does not hold when the command was killed or never started', () => {
    expect(judgeSelfcheck({ status: null, output: JEST_THRESHOLD, gatePath: GATE })).toBe(
      'the gate command did not run to completion'
    );
  });

  it('does not hold when the gate fails for another reason', () => {
    expect(
      judgeSelfcheck({
        status: 1,
        output: 'Error: Cannot find module "./jest.gates.config.js"\n',
        gatePath: GATE,
      })
    ).toBe(
      'the gate failed (exit 1) but not on the coverage threshold of src/common/shipping-fee.ts. It may be failing for another reason'
    );
  });

  it('does not hold when the threshold failure is about a different file', () => {
    const output =
      'Jest: "/work/app/src/common/another.ts" coverage threshold for lines (100%) not met: 0%\n' +
      'src/common/shipping-fee.ts | 100 | 100 | 100 | 100 |\n';
    expect(judgeSelfcheck({ status: 1, output, gatePath: GATE })).toContain(
      'not on the coverage threshold of src/common/shipping-fee.ts'
    );
  });

  it('uses settings.selfcheck.failurePattern instead of the built-in detection', () => {
    const output = 'GATE FAILED: src/common/shipping-fee.ts below 100\n';
    expect(
      judgeSelfcheck({
        status: 1,
        output,
        gatePath: GATE,
        failurePattern: 'GATE FAILED: {gate} below',
      })
    ).toBeNull();
    // The built-in detection would have rejected this output.
    expect(judgeSelfcheck({ status: 1, output, gatePath: GATE })).not.toBeNull();
  });

  it('escapes the gate path inside failurePattern', () => {
    expect(
      judgeSelfcheck({
        status: 1,
        output: 'FAILED srcXcommon/shipping-feeXts',
        gatePath: GATE,
        failurePattern: 'FAILED {gate}',
      })
    ).toBe(
      'the gate failed (exit 1) but the output does not match settings.selfcheck.failurePattern'
    );
  });

  it('still requires a non-zero exit when failurePattern matches', () => {
    expect(
      judgeSelfcheck({ status: 0, output: 'FAILED', gatePath: GATE, failurePattern: 'FAILED' })
    ).toContain('the gate passed');
  });

  it('ignores an empty or null failurePattern', () => {
    expect(
      judgeSelfcheck({ status: 1, output: JEST_THRESHOLD, gatePath: GATE, failurePattern: null })
    ).toBeNull();
    expect(
      judgeSelfcheck({ status: 1, output: 'unrelated', gatePath: GATE, failurePattern: '' })
    ).not.toBeNull();
  });
});

describe('selectControls', () => {
  const gates = ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts'];
  const none = { only: [], shard: null };

  it('selects every gate in mode all and only the first in mode first', () => {
    expect(selectControls({ gates, mode: 'all', ...none })).toEqual({ selected: gates });
    expect(selectControls({ gates, mode: 'first', ...none })).toEqual({ selected: ['src/a.ts'] });
  });

  it('selects the gates named with --gate, each once, in the order of test-gates.json', () => {
    expect(
      selectControls({
        gates,
        mode: 'all',
        only: ['src/d.ts', 'src/b.ts', 'src/d.ts'],
        shard: null,
      })
    ).toEqual({ selected: ['src/b.ts', 'src/d.ts'] });
  });

  it('lets --gate and --shard win over mode first', () => {
    expect(selectControls({ gates, mode: 'first', only: ['src/c.ts'], shard: null })).toEqual({
      selected: ['src/c.ts'],
    });
    expect(
      selectControls({ gates, mode: 'first', only: [], shard: { index: 2, total: 2 } })
    ).toEqual({ selected: ['src/b.ts', 'src/d.ts'] });
  });

  it('refuses a --gate that is not a gate, and names every such path', () => {
    expect(
      selectControls({
        gates,
        mode: 'all',
        only: ['src/b.ts', './src/a.ts', 'src/x.ts'],
        shard: null,
      })
    ).toEqual({
      error:
        '--gate ./src/a.ts, src/x.ts: not a gate of test-gates.json (write the path as it is written there)',
    });
  });

  it('deals the gates out to the parts of --shard in turn', () => {
    const part = (index: number, total: number) =>
      selectControls({ gates, mode: 'all', only: [], shard: { index, total } });
    expect(part(1, 1)).toEqual({ selected: gates });
    expect(part(1, 2)).toEqual({ selected: ['src/a.ts', 'src/c.ts', 'src/e.ts'] });
    expect(part(2, 2)).toEqual({ selected: ['src/b.ts', 'src/d.ts'] });
    expect(part(1, 3)).toEqual({ selected: ['src/a.ts', 'src/d.ts'] });
    expect(part(2, 3)).toEqual({ selected: ['src/b.ts', 'src/e.ts'] });
    expect(part(3, 3)).toEqual({ selected: ['src/c.ts'] });
    expect(part(5, 5)).toEqual({ selected: ['src/e.ts'] });
  });

  it.each([1, 2, 3, 4, 5])('covers every gate exactly once with %i part(s)', (total) => {
    const all = Array.from({ length: total }, (_unused, position) => {
      const part = selectControls({
        gates,
        mode: 'all',
        only: [],
        shard: { index: position + 1, total },
      });
      return 'selected' in part ? part.selected : [];
    });
    expect(all.every((part) => part.length > 0)).toBe(true);
    expect(all.flat().sort()).toEqual(gates);
  });

  it('refuses more parts than gates, because a part without a gate would check nothing', () => {
    expect(selectControls({ gates, mode: 'all', only: [], shard: { index: 6, total: 6 } })).toEqual(
      {
        error:
          '--shard 6/6: there are only 5 gate(s). A part without a gate would pass without checking anything',
      }
    );
    expect(
      selectControls({ gates, mode: 'all', only: [], shard: { index: 1, total: 6 } })
    ).toHaveProperty('error');
  });
});

describe('excludedSpecs', () => {
  it('names the variable for several specs', () => {
    expect(EXCLUDE_ALL_ENV).toBe('TEST_GATES_EXCLUDE_SPECS');
  });

  it('leaves nothing out when neither variable is set, or both are empty', () => {
    expect(excludedSpecs({})).toEqual([]);
    expect(excludedSpecs({ TEST_GATES_EXCLUDE_SPEC: '', TEST_GATES_EXCLUDE_SPECS: '' })).toEqual(
      []
    );
  });

  it('reads the one spec, the list, and both together', () => {
    expect(excludedSpecs({ TEST_GATES_EXCLUDE_SPEC: 'src/a.spec.ts' })).toEqual(['src/a.spec.ts']);
    expect(
      excludedSpecs({ TEST_GATES_EXCLUDE_SPECS: '["src/a.spec.ts","src/b.spec.ts"]' })
    ).toEqual(['src/a.spec.ts', 'src/b.spec.ts']);
    expect(
      excludedSpecs({
        TEST_GATES_EXCLUDE_SPEC: 'src/c.spec.ts',
        TEST_GATES_EXCLUDE_SPECS: '["src/a.spec.ts"]',
      })
    ).toEqual(['src/c.spec.ts', 'src/a.spec.ts']);
    expect(excludedSpecs({ TEST_GATES_EXCLUDE_SPECS: '[]' })).toEqual([]);
  });

  it.each([
    '{',
    '"src/a.spec.ts"',
    '{"0":"src/a.spec.ts"}',
    '["src/a.spec.ts",1]',
    'null',
    '[null]',
  ])('refuses a list written as %s', (value) => {
    expect(() => excludedSpecs({ TEST_GATES_EXCLUDE_SPECS: value })).toThrow(
      new Error('test-gates: TEST_GATES_EXCLUDE_SPECS must be a JSON list of spec paths')
    );
  });
});

const c = (s: number[], f: number[] = [], b: number[] = []) => ({ s, f, b });

describe('accountedFor', () => {
  it('says yes when the notes add up to the total, counter by counter', () => {
    expect(
      accountedFor(c([2, 5], [5], [3, 2]), [c([1, 2], [2], [1, 1]), c([1, 3], [3], [2, 1])])
    ).toBe('yes');
    expect(accountedFor(c([1], [1]), [c([1], [1])])).toBe('yes');
    // A spec that loaded the file and executed nothing of it.
    expect(accountedFor(c([1], [1]), [c([1], [1]), c([0], [0])])).toBe('yes');
  });

  it('says no when the runner counted an execution no note has', () => {
    // a function that was called once more, after the notes were taken
    expect(accountedFor(c([2], [3]), [c([1], [1]), c([1], [1])])).toBe('no');
    expect(accountedFor(c([3], [2]), [c([1], [1]), c([1], [1])])).toBe('no');
    expect(accountedFor(c([2], [2], [2, 1]), [c([1], [1], [1, 0]), c([1], [1], [0, 1])])).toBe(
      'no'
    );
    // and when a note has more than the runner counted
    expect(accountedFor(c([1], [1]), [c([1], [1]), c([1], [1])])).toBe('no');
  });

  it('compares functions and branch arms as sets of counts: the report may order them otherwise', () => {
    expect(accountedFor(c([1, 4], [4, 1], [0, 2]), [c([1, 4], [1, 4], [2, 0])])).toBe('yes');
    expect(accountedFor(c([1, 4], [4, 2], [0, 2]), [c([1, 4], [1, 4], [2, 0])])).toBe('no');
    expect(accountedFor(c([1, 4], [4, 1], [1, 2]), [c([1, 4], [1, 4], [2, 0])])).toBe('no');
    expect(accountedFor(c([4, 1], [1, 4]), [c([1, 4], [1, 4])])).toBe('yes');
  });

  it('lets several statements of the notes be one statement of the report, each used once', () => {
    // three statements in the compiled file, two in the source
    expect(accountedFor(c([2, 5], [5]), [c([1, 1, 2], [2]), c([1, 1, 3], [3])])).toBe('yes');
    expect(accountedFor(c([2, 6], [5]), [c([1, 1, 2], [2]), c([1, 1, 3], [3])])).toBe('no');
    expect(accountedFor(c([5, 5], [5]), [c([1, 1, 2], [2]), c([1, 1, 3], [3])])).toBe('no');
    expect(accountedFor(c([2, 2], [5]), [c([1, 1, 2], [2]), c([1, 1, 3], [3])])).toBe('yes');
    expect(accountedFor(c([10, 9], [5]), [c([9, 1, 10], [5])])).toBe('yes');
    // With as many statements on both sides, they have to be the same.
    expect(accountedFor(c([2, 2, 5], [5]), [c([1, 1, 2], [2]), c([1, 1, 3], [3])])).toBe('yes');
    expect(accountedFor(c([2, 5, 5], [5]), [c([1, 1, 2], [2]), c([1, 1, 3], [3])])).toBe('no');
  });

  it('says unknown when there is nothing to compare, or functions and branches do not line up', () => {
    expect(accountedFor(undefined, [c([1], [1])])).toBe('unknown');
    expect(accountedFor(c([1], [1]), [])).toBe('unknown');
    expect(accountedFor(c([1], [1, 1]), [c([1], [1])])).toBe('unknown');
    expect(accountedFor(c([1], [1], [1]), [c([1], [1], [1, 1])])).toBe('unknown');
    // notes of one file that do not line up with each other
    expect(accountedFor(c([2], [2]), [c([1], [1]), c([1, 0], [1])])).toBe('unknown');
    expect(accountedFor(c([2], [2]), [c([1], [1]), c([1], [1, 0])])).toBe('unknown');
    expect(accountedFor(c([2], [2], [2]), [c([1], [1], [1]), c([1], [1], [1, 0])])).toBe('unknown');
  });
});

const jestRun = {
  runner: 'jest',
  version: '30.5.2',
  provider: 'babel',
  pool: 'default',
  isolate: true,
  projects: 1,
  problem: null,
};
const vitestRun = {
  runner: 'vitest',
  version: '3.2.7',
  provider: 'istanbul',
  pool: 'forks',
  isolate: true,
  projects: 1,
  problem: null,
};

describe('the runs the shared run is verified with', () => {
  it('lists them in one table', () => {
    expect(VERIFIED_RUNS).toEqual([
      { runner: 'jest', versions: ['30.5'], provider: 'babel', pools: ['default'] },
      { runner: 'vitest', versions: ['3.2'], provider: 'istanbul', pools: ['forks', 'threads'] },
    ]);
  });

  it('reads major.minor from a version', () => {
    expect(minorOf('30.5.2')).toBe('30.5');
    expect(minorOf('30.15.2')).toBe('30.15');
    expect(minorOf('130.5.0-rc.1')).toBe('130.5');
    expect(minorOf('3.2')).toBe('3.2');
    expect(minorOf('unknown')).toBe('unknown');
    expect(minorOf('v3.2.1')).toBe('v3.2.1');
  });

  it('names every verified version of a runner when it refuses another', () => {
    const table = [{ runner: 'vitest', versions: ['3.2', '4.1'] }];
    expect(unverifiedVersion('vitest', '4.1.11', table)).toBeNull();
    expect(unverifiedVersion('vitest', '4.0.0', table)).toBe(
      'the shared run is verified with vitest 3.2, 4.1, not with 4.0.0'
    );
    expect(unverifiedVersion('jest', '30.5.2', table)).toBe(
      'the shared run is not verified with jest'
    );
  });

  it('accepts a runner by its major and minor version', () => {
    expect(unverifiedVersion('jest', '30.5.0')).toBeNull();
    expect(unverifiedVersion('jest', '30.5.99')).toBeNull();
    expect(unverifiedVersion('vitest', '3.2.7')).toBeNull();
    expect(unverifiedVersion('vitest', '3.2.0-beta.1')).toBeNull();
    expect(unverifiedVersion('vitest', '3.2')).toBeNull();
  });

  it.each([
    ['jest', '30.6.0', 'the shared run is verified with jest 30.5, not with 30.6.0'],
    ['jest', '29.7.0', 'the shared run is verified with jest 30.5, not with 29.7.0'],
    ['jest', '130.5.0', 'the shared run is verified with jest 30.5, not with 130.5.0'],
    ['jest', '30.50.0', 'the shared run is verified with jest 30.5, not with 30.50.0'],
    ['vitest', '4.0.0', 'the shared run is verified with vitest 3.2, not with 4.0.0'],
    ['vitest', '3.20.1', 'the shared run is verified with vitest 3.2, not with 3.20.1'],
    ['vitest', 'x3.2.1', 'the shared run is verified with vitest 3.2, not with x3.2.1'],
    ['vitest', 'unknown', 'the shared run is verified with vitest 3.2, not with unknown'],
    ['mocha', '11.0.0', 'the shared run is not verified with mocha'],
  ])('refuses %s %s', (runner, version, reason) => {
    expect(unverifiedVersion(runner, version)).toBe(reason);
  });

  it('accepts a run that is in the table', () => {
    expect(unverifiedRun(jestRun)).toBeNull();
    expect(unverifiedRun(vitestRun)).toBeNull();
    expect(unverifiedRun({ ...vitestRun, pool: 'threads' })).toBeNull();
  });

  it.each([
    [{ ...vitestRun, problem: 'the provider changed' }, 'the provider changed'],
    [
      { ...vitestRun, version: '4.1.0' },
      'the shared run is verified with vitest 3.2, not with 4.1.0',
    ],
    [{ ...vitestRun, version: '4.1.0', problem: 'first' }, 'first'],
    [
      { ...vitestRun, provider: 'v8' },
      'the shared run is not verified with the coverage provider v8',
    ],
    [
      { ...jestRun, provider: 'v8' },
      'the shared run is not verified with the coverage provider v8',
    ],
    [{ ...vitestRun, pool: 'vmThreads' }, 'the shared run is not verified with the pool vmThreads'],
    [{ ...jestRun, pool: 'forks' }, 'the shared run is not verified with the pool forks'],
    [
      { ...vitestRun, isolate: false },
      'the shared run is not verified with spec files that share their modules (isolate: false)',
    ],
    [{ ...vitestRun, projects: 2 }, 'the shared run is not verified with 2 projects in one run'],
    [{ ...jestRun, projects: 0 }, 'the shared run is not verified with 0 projects in one run'],
    [{ ...jestRun, runner: 'mocha' }, 'the shared run is not verified with mocha'],
    [
      { ...vitestRun, provider: 'v8', pool: 'vmThreads', isolate: false, projects: 3 },
      'the shared run is not verified with the coverage provider v8',
    ],
    [
      { ...vitestRun, pool: 'vmThreads', isolate: false, projects: 3 },
      'the shared run is not verified with the pool vmThreads',
    ],
    [
      { ...vitestRun, isolate: false, projects: 3 },
      'the shared run is not verified with spec files that share their modules (isolate: false)',
    ],
  ])('refuses a run outside of the table (%#)', (run, reason) => {
    expect(unverifiedRun(run)).toBe(reason);
  });
});

describe('--quick', () => {
  it.each(['true', '1', 'TRUE', 'True', 'yes', 'woodpecker', ' true ', '2'])(
    'is refused when CI is %j',
    (value) => {
      expect(quickRefused({ CI: value })).toBe(
        '--quick is refused in CI (the variable CI is set): what it reports as holding is not the final check. Run selfcheck without it, with --shard to split it over jobs'
      );
    }
  );

  it.each([undefined, '', '  ', 'false', 'FALSE', 'False', '0', ' 0 '])(
    'is allowed when CI is %j',
    (value) => {
      expect(quickRefused({ CI: value })).toBeNull();
      expect(quickRefused({ OTHER: 'true' })).toBeNull();
    }
  );

  it('says in the last line that a shared run is not the final check, when one was used', () => {
    expect(quickCaveat(0)).toBe('');
    expect(quickCaveat(3)).toBe(
      '. Of the controls that held, 3 came from one shared run (--quick), which a spec that depends on other specs can make differ from a run per gate: run without --quick for the final check'
    );
    expect(quickCaveat(1)).toContain('. Of the controls that held, 1 came from');
  });
});

describe('sharedRunPrecheck', () => {
  const configForJest = 'module.exports = createJestGatesConfig({ rootDir: __dirname });';
  const configForVitest =
    "export default createVitestGatesConfig({ coverageProvider: 'istanbul' });";

  it('says nothing when the run for notes may be of use', () => {
    expect(
      sharedRunPrecheck({
        specs: [],
        program: 'jest',
        version: '30.5.2',
        configSource: configForJest,
      })
    ).toBeNull();
    expect(
      sharedRunPrecheck({
        specs: [],
        program: 'vitest',
        version: '3.2.7',
        configSource: configForVitest,
      })
    ).toBeNull();
    // a gate command of the project's own: its config is not known
    expect(
      sharedRunPrecheck({ specs: [], program: 'jest', version: '30.5.2', configSource: null })
    ).toBeNull();
    // the runner is not installed where it is looked for
    expect(
      sharedRunPrecheck({
        specs: [],
        program: 'vitest',
        version: null,
        configSource: configForVitest,
      })
    ).toBeNull();
    expect(
      sharedRunPrecheck({ specs: [], program: 'vitest', version: null, configSource: null })
    ).toBeNull();
  });

  it('says nothing about a program it does not know, whatever the rest', () => {
    expect(
      sharedRunPrecheck({ specs: [], program: 'node', version: '1.0.0', configSource: 'x' })
    ).toBeNull();
    expect(
      sharedRunPrecheck({ specs: [], program: 'npx', version: null, configSource: null })
    ).toBeNull();
    expect(
      sharedRunPrecheck({ specs: [], program: 'jest2', version: '1.0.0', configSource: 'x' })
    ).toBeNull();
  });

  it('knows beforehand that a version outside of the table gets a run per gate', () => {
    expect(
      sharedRunPrecheck({
        specs: [],
        program: 'vitest',
        version: '4.0.1',
        configSource: configForVitest,
      })
    ).toBe('the shared run is verified with vitest 3.2, not with 4.0.1');
    expect(
      sharedRunPrecheck({ specs: [], program: 'jest', version: '29.7.0', configSource: null })
    ).toBe('the shared run is verified with jest 30.5, not with 29.7.0');
  });

  it('knows beforehand that a config without the helper leaves no notes', () => {
    expect(
      sharedRunPrecheck({
        specs: [],
        program: 'jest',
        version: '30.5.2',
        configSource: 'module.exports = {};',
      })
    ).toBe('the gate config does not use createJestGatesConfig');
    expect(
      sharedRunPrecheck({
        specs: [],
        program: 'jest',
        version: null,
        configSource: configForVitest,
      })
    ).toBe('the gate config does not use createJestGatesConfig');
    expect(
      sharedRunPrecheck({
        specs: [],
        program: 'vitest',
        version: '3.2.7',
        configSource: configForJest,
      })
    ).toBe('the gate config does not use createVitestGatesConfig');
  });

  it.each([
    'if (process.env.TEST_GATES_EXCLUDE_SPEC) { extra(); }',
    'const mode = process . env.MODE;',
    'const mode = import.meta.env.MODE;',
    "import fs from 'node:fs';",
    'const fs = require("fs");',
    "import { readFile } from 'fs/promises';",
    "import { readFile } from 'node:fs/promises';",
    'const { execSync } = require(`child_process`);',
    "import { Worker } from 'node:worker_threads';",
    "import net from 'net';",
    "import http from 'http';",
    "import https from 'node:https';",
  ])('refuses a spec that can see what is around it: %s', (source) => {
    const specs = [
      { path: 'src/a.spec.ts', source: "it('x', () => {});" },
      { path: 'src/b.spec.ts', source },
      { path: 'src/c.spec.ts', source },
    ];
    expect(sharedRunPrecheck({ specs, program: 'node', version: null, configSource: null })).toBe(
      'src/b.spec.ts reads the environment or files, so what it executes may depend on which other specs ran'
    );
  });

  it.each([
    "import { fee } from './fs';",
    "import path from 'node:path';",
    'const processEnv = 1; const env = process.argv;',
    "it('reads fs', () => { expect(name).toBe('fs/promises!'); });",
    "import x from 'https-proxy';",
    'const process_env = unprocess.environment;',
  ])('lets a spec pass that only looks like it: %s', (source) => {
    expect(
      sharedRunPrecheck({
        specs: [{ path: 'src/a.spec.ts', source }],
        program: 'node',
        version: null,
        configSource: null,
      })
    ).toBeNull();
  });

  it('knows beforehand that Vitest with the v8 provider leaves no notes', () => {
    const v8 = 'export default createVitestGatesConfig({ rootDir: import.meta.url });';
    expect(
      sharedRunPrecheck({ specs: [], program: 'vitest', version: '3.2.7', configSource: v8 })
    ).toBe(
      "Vitest measures with the v8 provider; the shared run needs coverageProvider: 'istanbul'"
    );
    // Jest has one provider under the helper.
    expect(
      sharedRunPrecheck({
        specs: [],
        program: 'jest',
        version: '30.5.2',
        configSource: configForJest,
      })
    ).toBeNull();
  });
});

describe('planControls', () => {
  const gate = (name: string) => ({
    path: `src/${name}.ts`,
    file: `/work/src/${name}.ts`,
    specFile: `/work/src/${name}.spec.ts`,
  });
  const all = [gate('a'), gate('b'), gate('c'), gate('d')];
  const targets = all.map((entry) => entry.path);
  const hit = c([1], [1]);
  const loaded = c([0], [0]);
  /** The note of the spec of `name`: all of its own gate, and the given counters of others. */
  const note = (name: string, others: Record<string, ReturnType<typeof c>> = {}) => ({
    spec: `/work/src/${name}.spec.ts`,
    files: {
      [`/work/src/${name}.ts`]: hit,
      ...Object.fromEntries(
        Object.entries(others).map(([other, counters]) => [`/work/src/${other}.ts`, counters])
      ),
    },
  });
  const notes = [note('a'), note('b'), note('c'), note('d')];
  const totalsOf = (counts: Record<string, ReturnType<typeof c>>) =>
    Object.fromEntries(
      Object.entries(counts).map(([name, counters]) => [`/work/src/${name}.ts`, counters])
    );
  const totals = totalsOf({ a: hit, b: hit, c: hit, d: hit });
  const plan = (changes: Partial<Parameters<typeof planControls>[0]> = {}) =>
    planControls({ all, targets, run: vitestRun, notes, totals, failurePattern: null, ...changes });
  const everyoneAlone = (reason: string) => ({ together: [], alone: targets, reason });
  const NO_NOTES =
    'the gate run left no notes (the gate config does not use the helpers of this package, or Vitest measures with the v8 provider)';

  it('lets every gate that only its own spec touches share one run', () => {
    expect(plan()).toEqual({ together: targets, alone: [], reason: null });
    expect(plan({ run: jestRun })).toEqual({ together: targets, alone: [], reason: null });
  });

  it('keeps the order of the targets, and plans only for them', () => {
    expect(plan({ targets: ['src/d.ts', 'src/b.ts'] })).toEqual({
      together: ['src/d.ts', 'src/b.ts'],
      alone: [],
      reason: null,
    });
  });

  it('gives a gate its own run when the spec of another gate touches it', () => {
    expect(
      plan({
        notes: [note('a'), note('b', { a: hit }), note('c'), note('d')],
        totals: totalsOf({ a: c([2], [2]), b: hit, c: hit, d: hit }),
      })
    ).toEqual({
      together: ['src/b.ts', 'src/c.ts', 'src/d.ts'],
      alone: ['src/a.ts'],
      reason: null,
    });
    // one statement, one function, one branch arm are each enough
    for (const touch of [c([1], [0], [0]), c([0], [1], [0]), c([0], [0], [1])]) {
      const one = c([1], [1], [1]);
      expect(
        plan({
          notes: [
            { spec: '/work/src/a.spec.ts', files: { '/work/src/a.ts': one } },
            note('b', { a: touch }),
            note('c'),
            note('d'),
          ],
          totals: totalsOf({
            a: c([1 + touch.s[0]!], [1 + touch.f[0]!], [1 + touch.b[0]!]),
            b: hit,
            c: hit,
            d: hit,
          }),
        }).alone
      ).toEqual(['src/a.ts']);
    }
  });

  it('lets a gate share the run when another spec loads it and executes nothing of it', () => {
    expect(plan({ notes: [note('a'), note('b', { a: loaded }), note('c'), note('d')] })).toEqual({
      together: targets,
      alone: [],
      reason: null,
    });
  });

  it('gives a gate its own run when its own spec is not seen to touch it', () => {
    const silent = { spec: '/work/src/a.spec.ts', files: {} };
    expect(
      plan({
        notes: [silent, note('b'), note('c'), note('d')],
        totals: totalsOf({ b: hit, c: hit, d: hit }),
      })
    ).toEqual({
      together: ['src/b.ts', 'src/c.ts', 'src/d.ts'],
      alone: ['src/a.ts'],
      reason: null,
    });
    // touched by exactly one spec, but not its own
    expect(plan({ notes: [silent, note('b', { a: hit }), note('c'), note('d')] }).alone).toEqual([
      'src/a.ts',
    ]);
    // loaded by its own spec with nothing executed
    expect(
      plan({
        notes: [
          { spec: '/work/src/a.spec.ts', files: { '/work/src/a.ts': loaded } },
          note('b'),
          note('c'),
          note('d'),
        ],
        totals: totalsOf({ a: loaded, b: hit, c: hit, d: hit }),
      }).alone
    ).toEqual(['src/a.ts']);
  });

  it('gives a gate its own run when its notes cannot be compared with the total', () => {
    // the report has no entry for it
    expect(plan({ totals: totalsOf({ b: hit, c: hit, d: hit }) })).toEqual({
      together: ['src/b.ts', 'src/c.ts', 'src/d.ts'],
      alone: ['src/a.ts'],
      reason: null,
    });
    // the report counts another number of functions
    expect(plan({ totals: totalsOf({ a: c([1], [1, 1]), b: hit, c: hit, d: hit }) }).alone).toEqual(
      ['src/a.ts']
    );
  });

  it('trusts no note when those of one gate do not add up to what the runner counted', () => {
    const reason = 'the notes of the specs do not add up to what the runner counted for src/c.ts';
    // The runner counted two calls of c, the notes have one: something ran after a note.
    expect(plan({ totals: totalsOf({ a: hit, b: hit, c: c([1], [2]), d: hit }) })).toEqual(
      everyoneAlone(reason)
    );
    // Also when that gate is not a target.
    expect(
      plan({
        targets: ['src/a.ts', 'src/b.ts'],
        totals: totalsOf({ a: hit, b: hit, c: c([2], [1]), d: hit }),
      })
    ).toEqual({
      together: [],
      alone: ['src/a.ts', 'src/b.ts'],
      reason,
    });
    // The first such gate in the order of test-gates.json is named.
    expect(
      plan({ totals: totalsOf({ a: hit, b: c([2], [2]), c: c([1], [2]), d: hit }) }).reason
    ).toBe('the notes of the specs do not add up to what the runner counted for src/b.ts');
  });

  it('gives every gate its own run when the note of a spec is missing', () => {
    expect(plan({ notes: notes.slice(1) })).toEqual(
      everyoneAlone('the gate run left no note for the spec of src/a.ts')
    );
    expect(plan({ notes: [] })).toEqual(
      everyoneAlone('the gate run left no note for the spec of src/a.ts')
    );
    // Also when the spec without a note is that of a gate that is not a target.
    expect(plan({ targets: ['src/a.ts', 'src/b.ts'], notes: notes.slice(0, 3) })).toEqual({
      together: [],
      alone: ['src/a.ts', 'src/b.ts'],
      reason: 'the gate run left no note for the spec of src/d.ts',
    });
  });

  it('gives every gate its own run when the gate run left nothing to plan on', () => {
    expect(plan({ run: null })).toEqual(everyoneAlone(NO_NOTES));
    expect(plan({ notes: null })).toEqual(everyoneAlone(NO_NOTES));
    expect(plan({ totals: null })).toEqual(everyoneAlone(NO_NOTES));
  });

  it('gives every gate its own run for a run outside of the verified ones', () => {
    expect(plan({ run: { ...vitestRun, version: '4.0.0' } })).toEqual(
      everyoneAlone('the shared run is verified with vitest 3.2, not with 4.0.0')
    );
    expect(plan({ run: { ...vitestRun, problem: 'no onAfterSuiteRun' } })).toEqual(
      everyoneAlone('no onAfterSuiteRun')
    );
  });

  it('gives every gate its own run when fewer than two could share one', () => {
    const reason = 'fewer than two gates are touched by their own spec only';
    expect(
      plan({
        notes: [note('a'), note('b', { a: hit, c: hit }), note('c', { a: hit, b: hit }), note('d')],
        totals: totalsOf({ a: c([3], [3]), b: c([2], [2]), c: c([2], [2]), d: hit }),
      })
    ).toEqual(everyoneAlone(reason));
    expect(plan({ targets: ['src/a.ts'] })).toEqual({ together: [], alone: ['src/a.ts'], reason });
    expect(plan({ targets: ['src/a.ts', 'src/b.ts'] })).toEqual({
      together: ['src/a.ts', 'src/b.ts'],
      alone: [],
      reason: null,
    });
  });

  it('gives every gate its own run for a failure pattern that does not name the gate', () => {
    const reason = 'settings.selfcheck.failurePattern does not contain {gate}';
    expect(plan({ failurePattern: 'threshold' })).toEqual(everyoneAlone(reason));
    // the first reason that applies is given
    expect(plan({ failurePattern: 'threshold', run: null })).toEqual(everyoneAlone(reason));
    expect(plan({ failurePattern: 'threshold.*{gate}' })).toEqual({
      together: targets,
      alone: [],
      reason: null,
    });
    expect(plan({ failurePattern: '' })).toEqual({ together: targets, alone: [], reason: null });
  });

  it('gives a gate its own run when its path is part of the path of another gate', () => {
    const nested = [
      ...all,
      { path: 'lib/src/a.ts', file: '/work/lib/src/a.ts', specFile: '/work/lib/src/a.spec.ts' },
    ];
    expect(
      planControls({
        all: nested,
        targets: nested.map((entry) => entry.path),
        run: vitestRun,
        notes: [
          ...notes,
          { spec: '/work/lib/src/a.spec.ts', files: { '/work/lib/src/a.ts': hit } },
        ],
        totals: { ...totals, '/work/lib/src/a.ts': hit },
        failurePattern: null,
      })
    ).toEqual({
      together: ['src/b.ts', 'src/c.ts', 'src/d.ts', 'lib/src/a.ts'],
      alone: ['src/a.ts'],
      reason: null,
    });
  });

  it('gives a target that is not a gate its own run', () => {
    expect(plan({ targets: ['src/a.ts', 'src/b.ts', 'src/x.ts'] })).toEqual({
      together: ['src/a.ts', 'src/b.ts'],
      alone: ['src/x.ts'],
      reason: null,
    });
  });
});

describe('mutation --affected', () => {
  it.each(['true', '1', 'woodpecker'])('runs every mutant when CI is %j', (value) => {
    expect(affectedRefused({ CI: value })).toBe(
      'CI is set, and there every mutant is run (the final check)'
    );
  });

  it.each([undefined, '', 'false', '0'])('may reuse results when CI is %j', (value) => {
    expect(affectedRefused({ CI: value })).toBeNull();
  });
});

describe('mutation --gate', () => {
  it.each(['true', '1', 'TRUE', 'woodpecker', ' true '])('is refused when CI is %j', (value) => {
    expect(gateRunRefused({ CI: value })).toBe(
      '--gate is refused in CI (the variable CI is set): a mutation run of a part of the gates is not the final check. Run mutation without it'
    );
  });

  it.each([undefined, '', '  ', 'false', 'FALSE', '0', ' 0 '])(
    'is allowed when CI is %j',
    (value) => {
      expect(gateRunRefused({ CI: value })).toBeNull();
      expect(gateRunRefused({ OTHER: 'true' })).toBeNull();
    }
  );

  it('says in the last line that the run is not the final check', () => {
    expect(gateRunCaveat(1, 9)).toBe(
      '. Only 1 of 9 gate(s) were run and judged (--gate), and a change in one gate can make a mutant of another survive: run without --gate for the final check'
    );
    expect(gateRunCaveat(2, 2)).toContain('. Only 2 of 2 gate(s) were run and judged');
  });
});
