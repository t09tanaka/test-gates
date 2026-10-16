/**
 * Stryker's incremental mode reuses the result of a mutant when the text at the place of the
 * mutant and a test that killed it are unchanged. That is not enough: a change on another line
 * of the same file, in another file the gate or the spec imports, in a config, a dependency or
 * a tool can turn a mutant that was killed into one that survives, and the old "Killed" would
 * be reused. This module decides whether the results of the last run may be reused: only when
 * everything the run depends on is what it was when they were written.
 */

export const RECORD_FORMAT = 2;

/** Everything a run depends on. */
export interface Snapshot {
  /** How the files were listed: through git, or by walking the directories. */
  mode: 'git' | 'walk';
  /** Versions of Node.js, of this tool, of Stryker and of the test runners. */
  environment: Record<string, string>;
  /** Arguments handed to Stryker, without `--force`. */
  args: string[];
  /** Hash of every file, by its path. */
  files: Record<string, string>;
}

/** What a run with `--affected` writes down about each gate (see core/affected.ts). */
export interface AffectedRecord {
  /** Every spec file the report of the run lists. */
  tests: string[];
  /**
   * The gates whose results may be reused by a later run: those with no survivor and no timeout
   * that the allow lists do not cover. Keys are paths of gates, as in test-gates.json.
   */
  gates: Record<string, AffectedGate>;
}

export interface AffectedGate {
  /** The spec files whose tests covered or killed a mutant of the gate. */
  specs: string[];
  /** Keys of the snapshot (`Snapshot.files`) that the results of the gate depend on. */
  files: string[];
}

/** What is written next to the incremental file after a run that Stryker finished. */
export interface GuardRecord {
  format: number;
  /** Hash of the incremental file the run wrote. */
  incremental: string;
  snapshot: Snapshot;
  /** Only after a run with `--affected`. */
  affected?: AffectedRecord;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === 'string')
  );
}

const isStringList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === 'string');

/** The part written by a run with `--affected`; null when it is not well formed. */
function parseAffected(value: unknown): AffectedRecord | null {
  const { tests, gates } = (value ?? {}) as Record<string, unknown>;
  if (!isStringList(tests) || typeof gates !== 'object' || gates === null || Array.isArray(gates)) {
    return null;
  }
  // No prototype: a gate may be called "constructor".
  const parsed = Object.create(null) as Record<string, AffectedGate>;
  for (const [gate, entry] of Object.entries(gates)) {
    const { specs, files } = (entry ?? {}) as Record<string, unknown>;
    if (!isStringList(specs) || !isStringList(files)) {
      return null;
    }
    parsed[gate] = { specs, files };
  }
  return { tests, gates: parsed };
}

/** The record as it was written, or null when `value` is not a record of this format. */
export function parseRecord(value: unknown): GuardRecord | null {
  // Anything but an object has none of the four, and fails the checks below.
  const { format, incremental, snapshot, affected } = (value ?? {}) as Record<string, unknown>;
  if (format !== RECORD_FORMAT || typeof incremental !== 'string') {
    return null;
  }
  if (typeof snapshot !== 'object' || snapshot === null) {
    return null;
  }
  const { mode, environment, args, files } = snapshot as Record<string, unknown>;
  if (mode !== 'git' && mode !== 'walk') {
    return null;
  }
  if (!isStringList(args) || !isStringRecord(environment) || !isStringRecord(files)) {
    return null;
  }
  const record: GuardRecord = { format, incremental, snapshot: { mode, environment, args, files } };
  if (affected !== undefined) {
    const parsed = parseAffected(affected);
    if (parsed === null) {
      return null;
    }
    record.affected = parsed;
  }
  return record;
}

/** The first names, and how many more there are. */
export function listed(names: string[]): string {
  const shown = names.slice(0, 3).join(', ');
  return names.length > 3 ? `${shown} and ${names.length - 3} more` : shown;
}

/** Keys whose value differs between the two, or that only one of them has. Sorted. */
export function differingKeys(
  before: Record<string, string>,
  after: Record<string, string>
): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((key) => before[key] !== after[key])
    .sort();
}

/**
 * Whether the record belongs to the incremental file as it is now and to a run under the same
 * tools and arguments; what is in the files is not compared here.
 *
 * @param input.record The parsed content of the record file; undefined when there is none or
 *   it cannot be read.
 * @param input.incremental Hash of the incremental file as it is now.
 * @param input.snapshot The state of everything the run depends on, as it is now.
 * @returns The record, or why the results of the last run cannot be reused.
 */
export function readRecord(input: {
  record: unknown;
  incremental: string;
  snapshot: Snapshot;
}): { record: GuardRecord } | { refused: string } {
  if (input.record === undefined) {
    return { refused: 'there is no record of the run that wrote the incremental file' };
  }
  const record = parseRecord(input.record);
  if (record === null) {
    return { refused: 'the record of the last run is not one this version can read' };
  }
  if (record.incremental !== input.incremental) {
    return { refused: 'the incremental file is not the one the last recorded run wrote' };
  }
  const before = record.snapshot;
  const now = input.snapshot;
  if (before.mode !== now.mode) {
    return {
      refused: `the files are listed in another way than in the last run (${before.mode}, now ${now.mode})`,
    };
  }
  const environment = differingKeys(before.environment, now.environment);
  if (environment.length > 0) {
    const changes = environment.map(
      (key) => `${key} ${before.environment[key] ?? 'none'} → ${now.environment[key] ?? 'none'}`
    );
    return { refused: `the tools changed since the last run: ${listed(changes)}` };
  }
  if (JSON.stringify(before.args) !== JSON.stringify(now.args)) {
    return { refused: 'the arguments for Stryker are not those of the last run' };
  }
  return { record };
}

/**
 * Decides whether Stryker may reuse the results in its incremental file: only when nothing at
 * all changed since the recorded run.
 *
 * @returns null when the results may be reused, otherwise why every mutant has to be run again.
 */
export function refuseReuse(input: {
  record: unknown;
  incremental: string;
  snapshot: Snapshot;
}): string | null {
  const read = readRecord(input);
  if ('refused' in read) {
    return read.refused;
  }
  const files = differingKeys(read.record.snapshot.files, input.snapshot.files);
  if (files.length > 0) {
    return `changed since the last run: ${listed(files)}`;
  }
  return null;
}

/** What a Stryker run does with its incremental file, from its config and its arguments. */
export interface IncrementalOptions {
  /** Whether Stryker reads and writes an incremental file at all. */
  incremental: boolean;
  /** Whether the run is already one of every mutant. */
  force: boolean;
  incrementalFile: string;
  tempDirName: string;
}

/**
 * Reads the options of a run. Arguments win over the config, as they do in Stryker.
 *
 * @param config The Stryker config as loaded (its default export).
 * @param args The arguments for `stryker run`.
 */
export function incrementalOptions(config: unknown, args: string[]): IncrementalOptions {
  const options = (typeof config === 'object' && config !== null ? config : {}) as Record<
    string,
    unknown
  >;
  const valueOf = (name: string): string | undefined => {
    let value: string | undefined;
    args.forEach((arg, position) => {
      if (arg === name) {
        value = args[position + 1];
      } else if (arg.startsWith(`${name}=`)) {
        value = arg.slice(name.length + 1);
      }
    });
    return value;
  };
  const fromConfig = (name: string, fallback: string): string =>
    typeof options[name] === 'string' ? options[name] : fallback;
  return {
    incremental: options.incremental === true || args.includes('--incremental'),
    force: options.force === true || args.includes('--force'),
    incrementalFile:
      valueOf('--incrementalFile') ??
      fromConfig('incrementalFile', 'reports/stryker-incremental.json'),
    tempDirName: valueOf('--tempDirName') ?? fromConfig('tempDirName', '.stryker-tmp'),
  };
}

/** The arguments as they are compared between runs: `--force` does not change a result. */
export function comparableArgs(args: string[]): string[] {
  return args.filter((arg) => arg !== '--force');
}

/** The object of a config as loaded, or an empty one. */
function objectOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

/**
 * The reports a Stryker run writes, relative to the subproject: those of its HTML and its JSON
 * reporter, at the defaults of Stryker where the config names none. What a run writes is not
 * something it depends on.
 *
 * @param config The Stryker config as loaded (its default export).
 */
export function reportFiles(config: unknown): string[] {
  const options = objectOf(config);
  const fileName = (reporter: string, fallback: string): string => {
    const named = objectOf(options[reporter]).fileName;
    return typeof named === 'string' ? named : fallback;
  };
  return [
    fileName('htmlReporter', 'reports/mutation/mutation.html'),
    fileName('jsonReporter', 'reports/mutation/mutation.json'),
  ];
}

/** What the wildcards of a pattern of ignorePatterns stand for. */
const WILDCARDS = new Map([
  ['**/', '(?:.*/)?'],
  ['*', '[^/]*'],
  ['?', '[^/]'],
]);

/**
 * A pattern of ignorePatterns as a regular expression: `*` and `?` within a part, a part `**`
 * for any parts before the next. Brackets and braces are taken as they are written, which
 * leaves out less than Stryker does.
 */
function globSource(glob: string): string {
  return glob
    .split(/(\*\*\/|\*|\?)/)
    .map((part) => WILDCARDS.get(part) ?? part.replace(/\W/g, '\\$&'))
    .join('');
}

/**
 * Whether Stryker leaves a file out of the run by the ignorePatterns of its config, which it
 * reads as a .gitignore: a pattern without a `/` matches a name at any depth, one with a `/` the
 * path from the subproject, one that ends in `/` a directory only. What lies in a directory that
 * is left out is left out with it. Where a pattern takes files back (`!`), nothing is left out:
 * Stryker then keeps files below a directory that is left out, and to leave out more than it does
 * would compare less than the run reads.
 *
 * @param config The Stryker config as loaded (its default export).
 * @returns A test of a path relative to the subproject, with `/` between its parts.
 */
export function strykerIgnores(config: unknown): (relative: string) => boolean {
  const patterns = [objectOf(config).ignorePatterns]
    .flat()
    .filter((pattern): pattern is string => typeof pattern === 'string');
  if (patterns.some((pattern) => pattern.startsWith('!'))) {
    return () => false;
  }
  const rules = patterns.map((pattern) => {
    const directoryOnly = pattern.endsWith('/');
    const body = pattern.replace(/\/+$/, '');
    const anchored = body.includes('/');
    const expression = new RegExp(`^${globSource(body.replace(/^\//, ''))}$`, 'i');
    return { directoryOnly, anchored, expression };
  });
  return (relative) => {
    const parts = relative.split('/');
    // the file itself, and each directory it lies in
    return rules.some((rule) =>
      parts.some((part, index) => {
        if (rule.directoryOnly && index === parts.length - 1) {
          return false;
        }
        const target = rule.anchored ? parts.slice(0, index + 1).join('/') : part;
        return rule.expression.test(target);
      })
    );
  };
}
