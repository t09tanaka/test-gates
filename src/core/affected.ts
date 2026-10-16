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
import { type AffectedRecord, differingKeys, listed } from './reuse-guard.js';

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
/** Jest uses a mock from `__mocks__` next to node_modules without being asked to. */
const CONFIG_DIRECTORIES = ['__mocks__', 'node_modules'];
const DOCUMENT = /\.(?:md|markdown|txt|rst|adoc)$/i;
const PASSIVE = /\.(?:[cm]?[jt]sx?|json|snap|css|scss|sass|less|svg|png|jpe?g|gif|webp|avif|ico)$/i;

/**
 * @param key A path as the snapshot lists it, relative to the root of what is listed.
 * @param subproject The subproject, relative to the same root ('' when it is the root).
 */
export function kindOf(key: string, subproject: string): FileKind {
  const inside = subproject === '' || key.startsWith(`${subproject}/`);
  const local = inside && subproject !== '' ? key.slice(subproject.length + 1) : key;
  const segments = local.split('/');
  const name = segments[segments.length - 1] as string;
  if (
    segments.some((segment) => CONFIG_DIRECTORIES.includes(segment)) ||
    CONFIG_NAMES.some((pattern) => pattern.test(name))
  ) {
    return 'config';
  }
  if (DOCUMENT.test(name)) {
    return 'document';
  }
  if (!inside || segments.length === 1 || !PASSIVE.test(name)) {
    return 'other';
  }
  return 'passive';
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
 *   and of what they name (setup files, mocks): a change there may affect every gate.
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
      full: 'the last run did not write down what each gate depends on (it ran without --affected)',
    };
  }
  const changed = differingKeys(input.before.files, input.now);
  const reached = new Set(input.gates.flatMap((gate) => gate.files));
  Object.values(recorded.gates).forEach((gate) => gate.files.forEach((file) => reached.add(file)));
  const config = new Set(input.config);
  const everywhere = changed.filter((key) => {
    const kind = kindOf(key, input.subproject);
    return config.has(key) || kind === 'config' || (kind === 'other' && !reached.has(key));
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

/** Lines that say what a run with `--affected` does: one, and one more per gate run again. */
export function describePlan(plan: AffectedPlan, shown = 5): string[] {
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
  return lines;
}
