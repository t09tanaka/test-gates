/**
 * Stryker's incremental mode reuses the result of a mutant when neither the mutated file nor
 * the test files changed. It does not see anything else: a file that a spec imports, a config,
 * a dependency, the tools. After such a change an old "Killed" would be reused for a mutant
 * that now survives. This module decides whether the results of the last run may be reused:
 * only when everything Stryker does not look at is what it was when they were written.
 */

export const RECORD_FORMAT = 1;

/** Everything a run depends on, apart from the gates and their specs. */
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

/** What is written next to the incremental file after a run that Stryker finished. */
export interface GuardRecord {
  format: number;
  /** Hash of the incremental file the run wrote. */
  incremental: string;
  snapshot: Snapshot;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === 'string')
  );
}

/** The record as it was written, or null when `value` is not a record of this format. */
export function parseRecord(value: unknown): GuardRecord | null {
  // Anything but an object has none of the three, and fails the checks below.
  const { format, incremental, snapshot } = (value ?? {}) as Record<string, unknown>;
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
  if (!Array.isArray(args) || !args.every((arg) => typeof arg === 'string')) {
    return null;
  }
  if (!isStringRecord(environment) || !isStringRecord(files)) {
    return null;
  }
  return { format, incremental, snapshot: { mode, environment, args: args as string[], files } };
}

/** The first names, and how many more there are. */
function listed(names: string[]): string {
  const shown = names.slice(0, 3).join(', ');
  return names.length > 3 ? `${shown} and ${names.length - 3} more` : shown;
}

/** Keys whose value differs between the two, or that only one of them has. Sorted. */
function differingKeys(before: Record<string, string>, after: Record<string, string>): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((key) => before[key] !== after[key])
    .sort();
}

/**
 * Decides whether Stryker may reuse the results in its incremental file.
 *
 * @param input.record The parsed content of the record file; undefined when there is none or
 *   it cannot be read.
 * @param input.incremental Hash of the incremental file as it is now.
 * @param input.snapshot The state of everything but the gates and their specs, as it is now.
 * @returns null when the results may be reused, otherwise why every mutant has to be run again.
 */
export function refuseReuse(input: {
  record: unknown;
  incremental: string;
  snapshot: Snapshot;
}): string | null {
  if (input.record === undefined) {
    return 'there is no record of the run that wrote the incremental file';
  }
  const record = parseRecord(input.record);
  if (record === null) {
    return 'the record of the last run is not one this version can read';
  }
  if (record.incremental !== input.incremental) {
    return 'the incremental file is not the one the last recorded run wrote';
  }
  const before = record.snapshot;
  const now = input.snapshot;
  if (before.mode !== now.mode) {
    return `the files are listed in another way than in the last run (${before.mode}, now ${now.mode})`;
  }
  const environment = differingKeys(before.environment, now.environment);
  if (environment.length > 0) {
    const changes = environment.map(
      (key) => `${key} ${before.environment[key] ?? 'none'} → ${now.environment[key] ?? 'none'}`
    );
    return `the tools changed since the last run: ${listed(changes)}`;
  }
  if (before.args.join('\n') !== now.args.join('\n')) {
    return 'the arguments for Stryker are not those of the last run';
  }
  const files = differingKeys(before.files, now.files);
  if (files.length > 0) {
    return `changed since the last run, and neither a gate nor its spec: ${listed(files)}`;
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
