import type { TouchRecord } from '../touch.js';
import type { Shard } from './args.js';

/** Environment variable through which `test-gates selfcheck` tells the gate config which spec to leave out. */
export const EXCLUDE_ENV = 'TEST_GATES_EXCLUDE_SPEC';

/**
 * The same for several specs at once: a JSON list of spec paths. Set instead of EXCLUDE_ENV in
 * the one run that stands in for the runs of all gates no other spec touches (see planControls).
 */
export const EXCLUDE_ALL_ENV = 'TEST_GATES_EXCLUDE_SPECS';

/**
 * The specs a gate run has to leave out, from both variables.
 * @throws when EXCLUDE_ALL_ENV is not a JSON list of strings: a run that leaves out the wrong
 *   specs must not look like a negative control.
 */
export function excludedSpecs(env: Record<string, string | undefined>): string[] {
  const one = env[EXCLUDE_ENV];
  const several = env[EXCLUDE_ALL_ENV];
  const excluded = one === undefined || one === '' ? [] : [one];
  if (several === undefined || several === '') {
    return excluded;
  }
  let listed: unknown = null;
  try {
    listed = JSON.parse(several);
  } catch {
    // not JSON: refused below
  }
  if (!Array.isArray(listed) || !listed.every((spec) => typeof spec === 'string')) {
    throw new Error(`test-gates: ${EXCLUDE_ALL_ENV} must be a JSON list of spec paths`);
  }
  return [...excluded, ...(listed as string[])];
}

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

/** A gate as planControls sees it. `file` and `specFile` are absolute paths. */
export interface ControlledGate {
  path: string;
  file: string;
  specFile: string;
}

/**
 * Decides which negative controls can share one run of the gate command.
 *
 * Leaving out the spec of gate G changes the coverage of G only by what that spec executed of
 * G. When the records of a full gate run show that no other spec executed anything of G, G is
 * at nothing without its spec, whatever other specs are left out with it. All such gates can
 * therefore lose their specs in the same run, and each is judged in it as it would be in a run
 * of its own, by the threshold the runner reports for it. Every other gate keeps its own run.
 *
 * @param input.all Every gate of test-gates.json: any of their specs may touch a gate.
 * @param input.targets Paths of the gates that get a negative control in this run.
 * @param input.records What each spec executed in a full gate run (see src/touch.ts).
 * @param input.failurePattern settings.selfcheck.failurePattern.
 * @returns `together`: gates whose controls share one run; `alone`: gates that need their own.
 *   Both in the order of `targets`.
 */
export function planControls(input: {
  all: ControlledGate[];
  targets: string[];
  records: TouchRecord[];
  failurePattern: string | null;
}): { together: string[]; alone: string[] } {
  const { all, targets, records } = input;
  const everyoneAlone = { together: [], alone: targets };
  // A pattern that does not name the gate would match the failure of any gate of the run.
  if (input.failurePattern !== null && !input.failurePattern.includes('{gate}')) {
    return everyoneAlone;
  }
  // Without the record of every spec, what touches a gate is not known.
  if (!all.every((gate) => records.some((record) => record.spec === gate.specFile))) {
    return everyoneAlone;
  }
  const together = targets.filter((target) => {
    const gate = all.find((candidate) => candidate.path === target);
    if (gate === undefined) {
      return false;
    }
    // The run's output is searched for the path: no other gate's path may contain it.
    if (all.some((other) => other.path !== gate.path && other.path.includes(gate.path))) {
      return false;
    }
    const touching = records
      .filter((record) => record.touched.includes(gate.file))
      .map((record) => record.spec);
    // Its own spec must be seen to touch it (else the records do not describe this gate), and
    // no other spec may.
    return touching.length === 1 && touching.includes(gate.specFile);
  });
  if (together.length < 2) {
    return everyoneAlone;
  }
  return { together, alone: targets.filter((target) => !together.includes(target)) };
}
