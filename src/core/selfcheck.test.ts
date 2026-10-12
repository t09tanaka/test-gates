import { describe, expect, it } from 'vitest';
import {
  EXCLUDE_ALL_ENV,
  EXCLUDE_ENV,
  excludedSpecs,
  judgeSelfcheck,
  planControls,
  selectControls,
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

describe('planControls', () => {
  const gate = (name: string) => ({
    path: `src/${name}.ts`,
    file: `/work/src/${name}.ts`,
    specFile: `/work/src/${name}.spec.ts`,
  });
  const all = [gate('a'), gate('b'), gate('c'), gate('d')];
  const targets = all.map((entry) => entry.path);
  const own = (name: string, ...others: string[]) => ({
    spec: `/work/src/${name}.spec.ts`,
    touched: [`/work/src/${name}.ts`, ...others.map((other) => `/work/src/${other}.ts`)],
  });
  const records = [own('a'), own('b'), own('c'), own('d')];
  const plan = (changes: Partial<Parameters<typeof planControls>[0]> = {}) =>
    planControls({ all, targets, records, failurePattern: null, ...changes });
  const everyoneAlone = { together: [], alone: targets };

  it('lets every gate that only its own spec touches share one run', () => {
    expect(plan()).toEqual({ together: targets, alone: [] });
    // A file that is not a gate (a setup file that is measured by mistake) does not matter.
    expect(
      plan({
        records: [
          { spec: '/work/src/a.spec.ts', touched: ['/work/src/a.ts', '/work/x.ts'] },
          ...records.slice(1),
        ],
      })
    ).toEqual({ together: targets, alone: [] });
  });

  it('keeps the order of the targets, and plans only for them', () => {
    expect(plan({ targets: ['src/d.ts', 'src/b.ts'] })).toEqual({
      together: ['src/d.ts', 'src/b.ts'],
      alone: [],
    });
  });

  it('gives a gate its own run when the spec of another gate touches it', () => {
    expect(plan({ records: [own('a'), own('b', 'a'), own('c'), own('d')] })).toEqual({
      together: ['src/b.ts', 'src/c.ts', 'src/d.ts'],
      alone: ['src/a.ts'],
    });
    // Two specs that each touch a part of it.
    expect(plan({ records: [own('a'), own('b', 'a'), own('c', 'a'), own('d')] }).alone).toEqual([
      'src/a.ts',
    ]);
  });

  it('gives a gate its own run when its own spec is not seen to touch it', () => {
    expect(
      plan({
        records: [{ spec: '/work/src/a.spec.ts', touched: [] }, own('b'), own('c'), own('d')],
      })
    ).toEqual({ together: ['src/b.ts', 'src/c.ts', 'src/d.ts'], alone: ['src/a.ts'] });
    // Touched by exactly one spec, but not its own.
    expect(
      plan({
        records: [{ spec: '/work/src/a.spec.ts', touched: [] }, own('b', 'a'), own('c'), own('d')],
      }).alone
    ).toEqual(['src/a.ts']);
  });

  it('gives every gate its own run when the record of a spec is missing', () => {
    expect(plan({ records: records.slice(1) })).toEqual(everyoneAlone);
    expect(plan({ records: [] })).toEqual(everyoneAlone);
    // Also when the spec without a record is that of a gate that is not a target.
    expect(plan({ targets: ['src/a.ts', 'src/b.ts'], records: records.slice(0, 3) })).toEqual({
      together: [],
      alone: ['src/a.ts', 'src/b.ts'],
    });
  });

  it('gives every gate its own run when fewer than two could share one', () => {
    expect(
      plan({ records: [own('a'), own('b', 'a', 'c', 'd'), own('c', 'a', 'b', 'd'), own('d')] })
    ).toEqual(everyoneAlone);
    expect(plan({ targets: ['src/a.ts'] })).toEqual({ together: [], alone: ['src/a.ts'] });
    expect(plan({ targets: ['src/a.ts', 'src/b.ts'] })).toEqual({
      together: ['src/a.ts', 'src/b.ts'],
      alone: [],
    });
  });

  it('gives every gate its own run for a failure pattern that does not name the gate', () => {
    expect(plan({ failurePattern: 'threshold' })).toEqual(everyoneAlone);
    expect(plan({ failurePattern: 'threshold.*{gate}' })).toEqual({ together: targets, alone: [] });
    expect(plan({ failurePattern: '' })).toEqual(everyoneAlone);
  });

  it('gives a gate its own run when its path is part of the path of another gate', () => {
    const nested = [
      ...all,
      { path: 'lib/src/a.ts', file: '/work/lib/src/a.ts', specFile: '/work/lib/src/a.spec.ts' },
    ];
    const nestedRecords = [
      ...records,
      { spec: '/work/lib/src/a.spec.ts', touched: ['/work/lib/src/a.ts'] },
    ];
    expect(
      planControls({
        all: nested,
        targets: nested.map((entry) => entry.path),
        records: nestedRecords,
        failurePattern: null,
      })
    ).toEqual({
      together: ['src/b.ts', 'src/c.ts', 'src/d.ts', 'lib/src/a.ts'],
      alone: ['src/a.ts'],
    });
  });

  it('gives a target that is not a gate its own run', () => {
    expect(plan({ targets: ['src/a.ts', 'src/b.ts', 'src/x.ts'] })).toEqual({
      together: ['src/a.ts', 'src/b.ts'],
      alone: ['src/x.ts'],
    });
  });
});
