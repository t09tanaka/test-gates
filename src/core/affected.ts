/**
 * `test-gates mutation --affected`: which gates have to be run again after a change, and which
 * may keep the results of the last run.
 *
 * The unit is the gate, never the mutant: Stryker's own judgement per mutant reuses old results
 * after changes that it does not take into account (see core/reuse-guard.ts). A gate keeps its
 * results only when no file they can depend on changed: the gate, every spec that can detect one
 * of its mutants, and every file those import. Anything that may change the results of every
 * gate (a config, a lock file, a tool, an argument) makes the run one of every mutant.
 */
import {
  expectedTimeoutMutants,
  type MutationReport,
  type ReportMutant,
} from './mutation-result.js';
import { type AffectedRecord, differingKeys, listed } from './reuse-guard.js';
import type { Gate } from './types.js';

/** What a change of a file can affect. */
export type FileKind =
  /** The results of every gate: configs, lock files, what is installed, mocks of packages. */
  | 'config'
  /** Only what imports it: sources, data, snapshots, styles, images. */
  | 'passive'
  /** Written for people; never read by a test run through an import. */
  | 'document'
  /** Anything else: also every file at the top of the subproject and outside of it. */
  | 'other';

const CONFIG_NAMES = [
  /^package\.json$/,
  /^(?:package-lock|npm-shrinkwrap)\.json$/,
  /^test-gates\.json$/,
  /^[jt]sconfig(?:\..*)?\.json$/,
  /\.config\.[^.]+$/,
  /\.config\.[^.]+\.[^.]+$/,
  /^(?:jest|vitest|vite|stryker|babel)[.-]/,
  /^\./,
  // Declarations need no import to take effect.
  /\.d\.[cm]?ts$/,
];
/** Jest uses a mock from the `__mocks__` next to node_modules without being asked to. */
const ROOT_MOCKS = '__mocks__';
const DOCUMENT = /\.(?:md|markdown|txt|rst|adoc)$/i;
const PASSIVE = /\.(?:[cm]?[jt]sx?|json|snap|css|scss|sass|less|svg|png|jpe?g|gif|webp|avif|ico)$/i;

/**
 * @param key A path as the snapshot lists it, relative to the root of what is listed.
 * @param subproject The subproject, relative to the same root ('' when it is the root).
 */
export function kindOf(key: string, subproject: string): FileKind {
  const segments = localSegments(key, subproject);
  const name = segments[segments.length - 1] as string;
  if (
    segments[0] === ROOT_MOCKS ||
    segments.includes('node_modules') ||
    CONFIG_NAMES.some((pattern) => pattern.test(name))
  ) {
    return 'config';
  }
  // A mock in a `__mocks__` below the top, `src/__mocks__/dep.ts`, is taken in place of the
  // module next to it (`src/dep.ts`): it is loaded with that module, so it affects the gates that
  // load the module. One that no gate loads may still be used by name (Jest's `roots`), so that
  // it is no file of a known kind.
  if (isNestedMock(key, subproject)) {
    return 'other';
  }
  if (DOCUMENT.test(name)) {
    return 'document';
  }
  const inside = subproject === '' || key.startsWith(`${subproject}/`);
  if (!inside || segments.length === 1 || !PASSIVE.test(name)) {
    return 'other';
  }
  return 'passive';
}

/** The parts of the path of a key, from the subproject on when it lies inside of it. */
function localSegments(key: string, subproject: string): string[] {
  const inside = subproject === '' || key.startsWith(`${subproject}/`);
  return (inside && subproject !== '' ? key.slice(subproject.length + 1) : key).split('/');
}

/** Whether a key lies in a `__mocks__` that is not the one at the top of the subproject. */
export function isNestedMock(key: string, subproject: string): boolean {
  return localSegments(key, subproject).slice(1, -1).includes(ROOT_MOCKS);
}

/**
 * The files the results of each gate depend on: the gate, its own specs, the specs whose tests
 * covered or killed one of its mutants, every spec that imports it, and what all of those import.
 * A spec that does not load the gate cannot see a mutant of it: Jest and Vitest give each spec
 * file a module registry of its own.
 *
 * @param input.gates Each gate with its own specs, as keys.
 * @param input.tests Every spec of the run, as keys.
 * @param input.covering For each gate, the specs whose tests covered or killed one of its mutants.
 * @param input.closures For the gate and each spec: the keys of the file and of every file it
 *   imports, directly or not.
 * @returns For each gate: the sorted keys, with the specs that were taken into account.
 */
export function gateDependencies(input: {
  gates: Array<{ key: string; specs: string[] }>;
  tests: string[];
  covering: Record<string, string[]>;
  closures: Record<string, string[]>;
}): Record<string, { specs: string[]; files: string[] }> {
  const closureOf = (key: string): string[] =>
    Object.hasOwn(input.closures, key) ? (input.closures[key] as string[]) : [key];
  const result = Object.create(null) as Record<string, { specs: string[]; files: string[] }>;
  for (const gate of input.gates) {
    const covering = Object.hasOwn(input.covering, gate.key) ? input.covering[gate.key] : [];
    const specs = new Set([...gate.specs, ...(covering as string[])]);
    for (const test of input.tests) {
      if (closureOf(test).includes(gate.key)) {
        specs.add(test);
      }
    }
    const files = new Set(closureOf(gate.key));
    for (const spec of specs) {
      closureOf(spec).forEach((file) => files.add(file));
    }
    result[gate.key] = { specs: [...specs].sort(), files: [...files].sort() };
  }
  return result;
}

export interface GateRerun {
  gate: string;
  /** The files that changed. Empty when the last run left no reusable result of the gate. */
  changed: string[];
}

export type AffectedPlan = { full: string } | { rerun: GateRerun[]; reused: string[] };

/**
 * Decides which gates are run again.
 *
 * @param input.before The files of the recorded run, and what it wrote down about each gate.
 * @param input.now The files as they are now (the same keys as `before.files`).
 * @param input.subproject The subproject, as a key.
 * @param input.config Keys of the Stryker config and the test runner config, of what they import
 *   and of what they name (setup files, mocks), and of the mocks below the top named as a package
 *   (`src/__mocks__/axios.ts`): a change there may affect every gate.
 * @param input.gates Each gate (its path as in test-gates.json, the order of that file), with the
 *   keys its results depend on as they are now.
 */
export function planAffected(input: {
  before: { files: Record<string, string>; affected: AffectedRecord | undefined };
  now: Record<string, string>;
  subproject: string;
  config: string[];
  gates: Array<{ path: string; files: string[] }>;
}): AffectedPlan {
  const recorded = input.before.affected;
  if (recorded === undefined) {
    return {
      full: 'the last run did not write down what each gate depends on (it ran in CI, with an older version, or could not tell)',
    };
  }
  const changed = differingKeys(input.before.files, input.now);
  const reached = new Set(input.gates.flatMap((gate) => gate.files));
  Object.values(recorded.gates).forEach((gate) => gate.files.forEach((file) => reached.add(file)));
  const config = new Set(input.config);
  const everywhere = changed.filter((key) => {
    const kind = kindOf(key, input.subproject);
    return (
      config.has(key) ||
      kind === 'config' ||
      (kind === 'other' && !reached.has(key)) ||
      // A mock that is gone may have been one of a package, which is used by name for every spec.
      (isNestedMock(key, input.subproject) && !Object.hasOwn(input.now, key))
    );
  });
  if (everywhere.length > 0) {
    return { full: `changed since the last run, and may affect every gate: ${listed(everywhere)}` };
  }
  const rerun: GateRerun[] = [];
  const reused: string[] = [];
  for (const gate of input.gates) {
    const last = Object.hasOwn(recorded.gates, gate.path) ? recorded.gates[gate.path] : undefined;
    if (last === undefined) {
      rerun.push({ gate: gate.path, changed: [] });
      continue;
    }
    const files = [...new Set([...last.files, ...gate.files])];
    const differing = files.filter((file) => input.before.files[file] !== input.now[file]).sort();
    if (differing.length > 0) {
      rerun.push({ gate: gate.path, changed: differing });
    } else {
      reused.push(gate.path);
    }
  }
  return { rerun, reused };
}

/** A path in test-gates.json as Stryker names it: without its `.` parts (`./src/a.ts`). */
export function withoutDots(file: string): string {
  return file
    .split('/')
    .filter((part) => part !== '.')
    .join('/');
}

/** The mutants that timed out in the last run, split by whether they are run again. */
export interface TimeoutRanges {
  /** As ranges for Stryker's `--mutate`. Mutants at the same place share one. */
  ranges: string[];
  /** How many are run again. */
  rerun: number;
  /** How many are taken over because an `expectedTimeouts` entry of their gate points at them. */
  expected: number;
}

/**
 * The mutants of the given gates that timed out in the last run, as ranges for Stryker's
 * `--mutate` (`file:line:column-line:column`; the start column counted from 0, the end column
 * included). A timeout can come from a loaded machine, where the mutant would have survived:
 * it is not taken over, also not in a gate whose other results are. Only a mutant that an
 * `expectedTimeouts` entry of its gate points at (matched as the verdict matches it) is taken
 * over: it times out on every run, and running it again only costs the time of its timeout.
 * A result that carries no source of its gate takes nothing over: the file on disk may have
 * changed since the result was made.
 */
export function timeoutRanges(
  last: MutationReport,
  gates: Array<Pick<Gate, 'path' | 'expectedTimeouts'>>
): TimeoutRanges {
  const ranges: string[] = [];
  const rerun = new Set<ReportMutant>();
  const taken = new Set<ReportMutant>();
  const files = last.files ?? {};
  for (const named of gates) {
    // Stryker names its files without `./`, which a path in test-gates.json may have.
    const gate = withoutDots(named.path);
    const result = Object.hasOwn(files, gate) ? files[gate] : undefined;
    if (result?.mutants === undefined) {
      continue;
    }
    const { mutants } = result;
    const expected = expectedTimeoutMutants(named, result.source, mutants);
    for (const mutant of mutants) {
      if (mutant.status !== 'Timeout') {
        continue;
      }
      if (expected.has(mutant)) {
        taken.add(mutant);
        continue;
      }
      rerun.add(mutant);
      const { start, end } = mutant.location;
      ranges.push(`${gate}:${start.line}:${start.column - 1}-${end.line}:${end.column}`);
    }
  }
  return { ranges: [...new Set(ranges)], rerun: rerun.size, expected: taken.size };
}

/** Lines that say what a run with `--affected` does: one, and one more per gate run again. */
export function describePlan(plan: AffectedPlan, shown = 5, timeouts = 0, expected = 0): string[] {
  if ('full' in plan) {
    return [
      `test-gates mutation --affected: running every mutant again (--force), the results of the last run are not reused: ${plan.full}`,
    ];
  }
  const total = plan.rerun.length + plan.reused.length;
  const lines = [
    `test-gates mutation --affected: ${plan.reused.length} of ${total} gate(s) reused, ${plan.rerun.length} run again`,
  ];
  for (const { gate, changed } of plan.rerun.slice(0, shown)) {
    lines.push(
      changed.length === 0
        ? `  ${gate}: the last run left no result of it that can be reused`
        : `  ${gate}: changed ${listed(changed)}`
    );
  }
  if (plan.rerun.length > shown) {
    lines.push(`  and ${plan.rerun.length - shown} more`);
  }
  if (timeouts > 0) {
    lines.push(`  and ${timeouts} mutant(s) of reused gates that timed out in the last run`);
  }
  if (expected > 0) {
    lines.push(`  ${describeExpected(expected)}`);
  }
  return lines;
}

/** What is said about the timed-out mutants that are taken over (see timeoutRanges). */
export function describeExpected(expected: number): string {
  return `${expected} mutant(s) that timed out in the last run are taken over: expectedTimeouts lists them`;
}
