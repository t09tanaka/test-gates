import type { Shard } from './args.js';

/** Environment variable through which `test-gates selfcheck` tells the gate config which spec to leave out. */
export const EXCLUDE_ENV = 'TEST_GATES_EXCLUDE_SPEC';

// Jest: `Jest: "<path>" coverage threshold for statements (100%) not met: 0%`
//       `Jest: Coverage data for <path> was not found.`
// Vitest: `ERROR: Coverage for lines (0%) does not meet global threshold (100%) for <path>`
const THRESHOLD_MESSAGE = /threshold|coverage data for/i;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Decides whether one negative control held: with the spec of `gatePath` left out, the gate
 * command must fail, and it must fail because of the coverage threshold of that very file.
 * A run that fails for another reason (a config that does not load) proves nothing.
 *
 * @param input.status Exit code of the gate command; null when it was killed or never started.
 * @param input.failurePattern Replaces the built-in threshold detection. `{gate}` stands for
 *   the gate path. Tested against the whole output.
 * @returns Why the control did not hold, or null when it held.
 */
export function judgeSelfcheck(input: {
  status: number | null;
  output: string;
  gatePath: string;
  failurePattern?: string | null;
}): string | null {
  const { status, output, gatePath } = input;
  if (status === null) {
    return 'the gate command did not run to completion';
  }
  if (status === 0) {
    return `the gate passed although the spec of ${gatePath} was left out. The gate does not measure this file (does the gate config honor ${EXCLUDE_ENV}?)`;
  }
  if (input.failurePattern) {
    const pattern = input.failurePattern.split('{gate}').join(escapeRegExp(gatePath));
    return new RegExp(pattern).test(output)
      ? null
      : `the gate failed (exit ${status}) but the output does not match settings.selfcheck.failurePattern`;
  }
  const reported = output
    .split('\n')
    .some((line) => line.includes(gatePath) && THRESHOLD_MESSAGE.test(line));
  return reported
    ? null
    : `the gate failed (exit ${status}) but not on the coverage threshold of ${gatePath}. It may be failing for another reason`;
}

/**
 * Decides which gates get a negative control in this run. Each control is independent of the
 * others, so a run of a part gives those gates the verdict they get in a run of all of them.
 * The parts of `--shard` are disjoint and together they are every gate: gate `k` (from 0, in
 * the order of test-gates.json) belongs to part `k % total + 1`.
 *
 * @param input.gates Paths of all gates, in the order of test-gates.json.
 * @param input.only Paths given with `--gate`. They win over `mode`.
 * @param input.shard Value of `--shard`. It wins over `mode`.
 * @returns The selected paths in the order of test-gates.json, or why the selection is refused.
 */
export function selectControls(input: {
  gates: string[];
  mode: 'all' | 'first';
  only: string[];
  shard: Shard | null;
}): { selected: string[] } | { error: string } {
  const { gates, mode, only, shard } = input;
  if (only.length > 0) {
    const unknown = only.filter((path) => !gates.includes(path));
    if (unknown.length > 0) {
      return {
        error: `--gate ${unknown.join(', ')}: not a gate of test-gates.json (write the path as it is written there)`,
      };
    }
    return { selected: gates.filter((path) => only.includes(path)) };
  }
  if (shard !== null) {
    if (shard.total > gates.length) {
      return {
        error: `--shard ${shard.index}/${shard.total}: there are only ${gates.length} gate(s). A part without a gate would pass without checking anything`,
      };
    }
    return {
      selected: gates.filter((_path, position) => position % shard.total === shard.index - 1),
    };
  }
  return { selected: mode === 'first' ? gates.slice(0, 1) : gates };
}
