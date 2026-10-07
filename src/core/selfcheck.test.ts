import { describe, expect, it } from 'vitest';
import { EXCLUDE_ENV, judgeSelfcheck } from './selfcheck';

const GATE = 'src/common/money.ts';

// Real output lines of the two runners when a file misses its threshold.
const JEST_THRESHOLD =
  'Jest: "/work/app/src/common/money.ts" coverage threshold for statements (100%) not met: 0%';
const JEST_NO_DATA = 'Jest: Coverage data for ./src/common/money.ts was not found.';
const VITEST_THRESHOLD =
  'ERROR: Coverage for lines (0%) does not meet global threshold (100%) for src/common/money.ts';

describe('judgeSelfcheck', () => {
  it('names the environment variable the gate config has to read', () => {
    expect(EXCLUDE_ENV).toBe('SEKISHO_EXCLUDE_SPEC');
  });

  it.each([
    ['Jest threshold message', JEST_THRESHOLD],
    ['Jest missing coverage data', JEST_NO_DATA],
    ['Vitest threshold message', VITEST_THRESHOLD],
  ])('holds when the gate fails with a %s for the gate', (_name, line) => {
    expect(
      judgeSelfcheck({ status: 1, output: `PASS other.spec.ts\n${line}\n`, gatePath: GATE })
    ).toBeNull();
  });

  it('holds for any non-zero exit code', () => {
    expect(judgeSelfcheck({ status: 2, output: VITEST_THRESHOLD, gatePath: GATE })).toBeNull();
  });

  it('does not hold when the gate passes', () => {
    expect(judgeSelfcheck({ status: 0, output: JEST_THRESHOLD, gatePath: GATE })).toBe(
      'the gate passed although the spec of src/common/money.ts was left out. The gate does not measure this file (does the gate config honor SEKISHO_EXCLUDE_SPEC?)'
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
      'the gate failed (exit 1) but not on the coverage threshold of src/common/money.ts. It may be failing for another reason'
    );
  });

  it('does not hold when the threshold failure is about a different file', () => {
    const output =
      'Jest: "/work/app/src/common/other.ts" coverage threshold for lines (100%) not met: 0%\n' +
      'src/common/money.ts | 100 | 100 | 100 | 100 |\n';
    expect(judgeSelfcheck({ status: 1, output, gatePath: GATE })).toContain(
      'not on the coverage threshold of src/common/money.ts'
    );
  });

  it('uses settings.selfcheck.failurePattern instead of the built-in detection', () => {
    const output = 'GATE FAILED: src/common/money.ts below 100\n';
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
        output: 'FAILED srcXcommon/moneyXts',
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
