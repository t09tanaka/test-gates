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
