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

/** The hit counts of one file: statements, functions, and every arm of every branch. */
export interface Counters {
  s: number[];
  f: number[];
  b: number[];
}

/** What one spec file executed in a full gate run: the counters of the files it loaded. */
export interface SpecNote {
  /** Absolute path of the spec file. */
  spec: string;
  /** By the absolute path of the measured file. */
  files: Record<string, Counters>;
}

/** How the gate run that wrote the notes ran. */
export interface RunInfo {
  runner: string;
  version: string;
  /** The coverage provider: `babel` for Jest, `istanbul` for Vitest. */
  provider: string;
  /** Vitest's pool; `default` for Jest. */
  pool: string;
  /** Whether every spec file ran with modules of its own. */
  isolate: boolean;
  /** Number of projects of the runner (a workspace has several). */
  projects: number;
  /** What the note-taking found wrong with the runner while it ran, or null. */
  problem: string | null;
}

/**
 * The runs for which this repository's tests compare the shared run with a run per gate
 * (`test/selfcheck-runners-*.test.ts`), by runner and its major.minor version. Outside of it the
 * notes are not trusted and every gate gets its own run.
 */
export const VERIFIED_RUNS: {
  runner: string;
  versions: string[];
  provider: string;
  pools: string[];
}[] = [
  { runner: 'jest', versions: ['30.5'], provider: 'babel', pools: ['default'] },
  { runner: 'vitest', versions: ['3.2'], provider: 'istanbul', pools: ['forks', 'threads'] },
];

/** `major.minor` of a version; the version itself when it is not written that way. */
export function minorOf(version: string): string {
  const match = /^(\d+\.\d+)\./.exec(version);
  return match === null ? version : (match[1] as string);
}

/** Why a runner of this version is outside of VERIFIED_RUNS, or null when it is inside. */
export function unverifiedVersion(
  runner: string,
  version: string,
  table: { runner: string; versions: string[] }[] = VERIFIED_RUNS
): string | null {
  const known = table.find((entry) => entry.runner === runner);
  if (known === undefined) {
    return `the shared run is not verified with ${runner}`;
  }
  return known.versions.includes(minorOf(version))
    ? null
    : `the shared run is verified with ${runner} ${known.versions.join(', ')}, not with ${version}`;
}

// The shared run takes for granted that a spec executes the same code whichever other specs
// run with it. A spec that looks at the environment (also at the variables of selfcheck
// itself) or at files can tell, and can cover another gate only while that gate's spec is away.
const SURROUNDINGS =
  /\bprocess\s*\.\s*env\b|\bimport\.meta\.env\b|['"`](?:node:)?(?:fs|fs\/promises|child_process|worker_threads|net|http|https)['"`]/;

/** Whether the environment says that the run is one of CI. */
export function inCi(env: Record<string, string | undefined>): boolean {
  // Providers write it as true, 1, True, TRUE or their own name: anything but empty, false or 0.
  const ci = (env.CI ?? '').trim().toLowerCase();
  return ci !== '' && ci !== 'false' && ci !== '0';
}

/**
 * `--quick` is for work in progress. Where the run is the gate itself, in CI, it is refused:
 * a control it reports as holding is not the final word.
 *
 * @returns Why `--quick` is refused in this environment, or null.
 */
export function quickRefused(env: Record<string, string | undefined>): string | null {
  return inCi(env)
    ? '--quick is refused in CI (the variable CI is set): what it reports as holding is not the final check. Run selfcheck without it, with --shard to split it over jobs'
    : null;
}

/**
 * `mutation --gate` runs the mutants of the named gates only, and is for work in progress too.
 * A change in one gate, in its spec or in a file they import can turn a mutant of another gate
 * into a survivor, and the mutants of that other gate are not run. In CI it is refused.
 *
 * @returns Why `mutation --gate` is refused in this environment, or null.
 */
export function gateRunRefused(env: Record<string, string | undefined>): string | null {
  return inCi(env)
    ? '--gate is refused in CI (the variable CI is set): a mutation run of a part of the gates is not the final check. Run mutation without it'
    : null;
}

/**
 * Why `mutation --affected` runs every mutant all the same; null when it may reuse results. In
 * CI the run is the final check.
 */
export function affectedRefused(env: Record<string, string | undefined>): string | null {
  return inCi(env) ? 'CI is set, and there every mutant is run (the final check)' : null;
}

/** What is said in the last line of a mutation run of the gates named with `--gate`. */
export function gateRunCaveat(judged: number, all: number): string {
  return `. Only ${judged} of ${all} gate(s) were run and judged (--gate), and a change in one gate can make a mutant of another survive: run without --gate for the final check`;
}

/** What is said in the last line when controls were judged in the run that --quick shares. */
export function quickCaveat(shared: number): string {
  return shared === 0
    ? ''
    : `. Of the controls that held, ${shared} came from one shared run (--quick), which a spec that depends on other specs can make differ from a run per gate: run without --quick for the final check`;
}

/**
 * What can be said before any run: why a full gate run for notes would be for nothing, or null
 * when that is not known. Saying nothing is always right; it costs one run.
 *
 * @param input.program The first word of the gate command.
 * @param input.version Version of that runner as installed; null when it is not found.
 * @param input.configSource Text of the gate config, when the gate command is the one derived
 *   from it; null for a gate command of the project's own.
 * @param input.specs The specs of all gates, with their text.
 */
export function sharedRunPrecheck(input: {
  program: string;
  version: string | null;
  configSource: string | null;
  specs: { path: string; source: string }[];
}): string | null {
  const reaching = input.specs.find((spec) => SURROUNDINGS.test(spec.source));
  if (reaching !== undefined) {
    return `${reaching.path} reads the environment or files, so what it executes may depend on which other specs ran`;
  }
  const runner = ['jest', 'vitest'].find((name) => name === input.program);
  if (runner === undefined) {
    return null;
  }
  if (input.version !== null) {
    const unverified = unverifiedVersion(runner, input.version);
    if (unverified !== null) {
      return unverified;
    }
  }
  if (input.configSource === null) {
    return null;
  }
  const helper = runner === 'jest' ? 'createJestGatesConfig' : 'createVitestGatesConfig';
  if (!input.configSource.includes(helper)) {
    return `the gate config does not use ${helper}`;
  }
  if (runner === 'vitest' && !input.configSource.includes('istanbul')) {
    return "Vitest measures with the v8 provider; the shared run needs coverageProvider: 'istanbul'";
  }
  return null;
}

/** Why the notes of this run are not trusted, or null when the run is one of VERIFIED_RUNS. */
export function unverifiedRun(run: RunInfo): string | null {
  if (run.problem !== null) {
    return run.problem;
  }
  const version = unverifiedVersion(run.runner, run.version);
  if (version !== null) {
    return version;
  }
  // A runner with a verified version is in the table.
  const known = VERIFIED_RUNS.find(
    (entry) => entry.runner === run.runner
  ) as (typeof VERIFIED_RUNS)[number];
  if (known.provider !== run.provider) {
    return `the shared run is not verified with the coverage provider ${run.provider}`;
  }
  if (!known.pools.includes(run.pool)) {
    return `the shared run is not verified with the pool ${run.pool}`;
  }
  if (!run.isolate) {
    return 'the shared run is not verified with spec files that share their modules (isolate: false)';
  }
  if (run.projects !== 1) {
    return `the shared run is not verified with ${run.projects} projects in one run`;
  }
  return null;
}

function sorted(counts: number[]): number[] {
  return [...counts].sort((left, right) => left - right);
}

/** Whether two lists of the same length hold the same counts in the same places. */
function same(left: number[], right: number[]): boolean {
  return left.every((count, index) => count === right[index]);
}

/** Whether every count of `part` can be paired with an equal count of `whole`, each used once. */
function contained(part: number[], whole: number[]): boolean {
  const left = sorted(whole);
  return sorted(part).every((count) => {
    const position = left.indexOf(count);
    if (position === -1) {
      return false;
    }
    left.splice(position, 1);
    return true;
  });
}

/**
 * Checks the notes of the specs against the runner's own total for one file. It does not use
 * the notes to say what a spec touched; it says whether the notes can be all there is: every
 * execution the runner counted has to be in the note of some spec. An execution that happened
 * after a note was taken, or outside of every note, shows as a total above the sum.
 *
 * The total is taken from the runner's report, which may have put the counters back onto the
 * source through a source map. Functions and branch arms keep their counts there (compared as
 * sets of counts, the order may differ); several statements of the compiled file can become
 * one, so each statement of the total needs an equal sum among the statements of the notes.
 *
 * @param total The runner's counters for the file; undefined when its report has none.
 * @param parts The counters of the file in the note of each spec that loaded it.
 * @returns `yes`: the notes account for the total. `no`: they do not, the notes are incomplete.
 *   `unknown`: the two cannot be compared (no total, or functions and branches do not line up).
 */
export function accountedFor(
  total: Counters | undefined,
  parts: Counters[]
): 'yes' | 'no' | 'unknown' {
  const first = parts[0];
  if (total === undefined || first === undefined) {
    return 'unknown';
  }
  const lined = parts.every(
    (part) =>
      part.s.length === first.s.length &&
      part.f.length === first.f.length &&
      part.b.length === first.b.length
  );
  if (!lined || total.f.length !== first.f.length || total.b.length !== first.b.length) {
    return 'unknown';
  }
  const sum = (key: 's' | 'f' | 'b') =>
    first[key].map((_count, index) =>
      parts.reduce((added, part) => added + (part[key][index] as number), 0)
    );
  // (With as many statements on both sides, "each paired with an equal one" means the same.)
  return same(sorted(total.f), sorted(sum('f'))) &&
    same(sorted(total.b), sorted(sum('b'))) &&
    contained(total.s, sum('s'))
    ? 'yes'
    : 'no';
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
 * G. When the notes of a full gate run show that no other spec executed anything of G, G is at
 * nothing without its spec, whatever other specs are left out with it. All such gates can
 * therefore lose their specs in the same run, and each is judged in it as it would be in a run
 * of its own, by the threshold the runner reports for it. Every other gate keeps its own run.
 *
 * All of this rests on the notes being complete. They are used only for a run of a runner,
 * version and setup the comparison has been verified with (unverifiedRun), and only when they
 * account for everything the runner itself counted (accountedFor): if they do not for a single
 * gate, none of them is trusted.
 *
 * @param input.all Every gate of test-gates.json: any of their specs may touch a gate.
 * @param input.targets Paths of the gates that get a negative control in this run.
 * @param input.run How the full gate run ran; null when it did not say.
 * @param input.notes What each spec executed in it; null when the notes cannot be read.
 * @param input.totals The runner's own counters, by file; null when it wrote none.
 * @param input.failurePattern settings.selfcheck.failurePattern.
 * @returns `together`: gates whose controls share one run; `alone`: gates that need their own,
 *   both in the order of `targets`. `reason`: why no run is shared, when none is.
 */
export function planControls(input: {
  all: ControlledGate[];
  targets: string[];
  run: RunInfo | null;
  notes: SpecNote[] | null;
  totals: Record<string, Counters> | null;
  failurePattern: string | null;
}): { together: string[]; alone: string[]; reason: string | null } {
  const { all, targets, run, notes, totals } = input;
  const everyoneAlone = (reason: string) => ({ together: [], alone: targets, reason });
  // A pattern that does not name the gate would match the failure of any gate of the run.
  // (An empty pattern counts as none, as it does for the judge.)
  if (input.failurePattern && !input.failurePattern.includes('{gate}')) {
    return everyoneAlone('settings.selfcheck.failurePattern does not contain {gate}');
  }
  if (run === null || notes === null || totals === null) {
    return everyoneAlone(
      'the gate run left no notes (the gate config does not use the helpers of this package, or Vitest measures with the v8 provider)'
    );
  }
  const unverified = unverifiedRun(run);
  if (unverified !== null) {
    return everyoneAlone(unverified);
  }
  // Without the note of every spec, what touches a gate is not known.
  const silent = all.find((gate) => !notes.some((note) => note.spec === gate.specFile));
  if (silent !== undefined) {
    return everyoneAlone(`the gate run left no note for the spec of ${silent.path}`);
  }
  const partsOf = (gate: ControlledGate) =>
    notes.flatMap((note) => (gate.file in note.files ? [note.files[gate.file] as Counters] : []));
  const short = all.find((gate) => accountedFor(totals[gate.file], partsOf(gate)) === 'no');
  if (short !== undefined) {
    return everyoneAlone(
      `the notes of the specs do not add up to what the runner counted for ${short.path}`
    );
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
    if (accountedFor(totals[gate.file], partsOf(gate)) !== 'yes') {
      return false;
    }
    const touching = notes
      .filter((note) => {
        const counters = note.files[gate.file];
        return (
          counters !== undefined &&
          [...counters.s, ...counters.f, ...counters.b].some((count) => count !== 0)
        );
      })
      .map((note) => note.spec);
    // Its own spec must be seen to touch it (else the notes do not describe this gate), and no
    // other spec may.
    return touching.length === 1 && touching.includes(gate.specFile);
  });
  if (together.length < 2) {
    return everyoneAlone('fewer than two gates are touched by their own spec only');
  }
  return { together, alone: targets.filter((target) => !together.includes(target)), reason: null };
}
