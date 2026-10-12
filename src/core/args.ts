export const COMMANDS = ['check', 'mutation', 'mutation-result', 'selfcheck', 'lcov'] as const;
export type Command = (typeof COMMANDS)[number];

export interface ParsedArgs {
  command: Command | null;
  help: boolean;
  version: boolean;
  dir: string;
  /** `--report` (mutation-result). */
  report: string | null;
  /** `--file` (lcov). */
  file: string | null;
  /** `--all` / `--first` (selfcheck). */
  mode: 'all' | 'first' | null;
  /** `--gate` (selfcheck, mutation), once per gate: only these gates. Empty: no selection. */
  gates: string[];
  /** `--quick` (selfcheck): gates that only their own spec touches share one run. */
  quick: boolean;
  /** `--shard <index>/<total>` (selfcheck): one of `total` parts of the gates, `index` from 1. */
  shard: Shard | null;
  /**
   * mutation: arguments handed to Stryker. selfcheck: the gate command to run instead of the
   * configured one.
   */
  rest: string[];
}

export interface Shard {
  index: number;
  total: number;
}

export class UsageError extends Error {}

const VALUE_OPTIONS = ['--dir', '--report', '--file', '--gate', '--shard'];

/** `<index>/<total>` with 1 <= index <= total, both written as plain decimal numbers. */
function parseShard(value: string): Shard {
  const match = /^([1-9]\d*)\/([1-9]\d*)$/.exec(value);
  const index = Number(match?.[1]);
  const total = Number(match?.[2]);
  // Without a match both numbers are NaN, and NaN is not a safe integer either. A total beyond
  // the safe integers would not be the number that was written.
  if (!Number.isSafeInteger(total) || index > total) {
    throw new UsageError(
      `--shard needs <index>/<total> with 1 <= index <= total (for example 2/4), got ${value}`
    );
  }
  return { index, total };
}

const OPTIONS_BY_COMMAND: Record<Command, string[]> = {
  check: ['--dir'],
  mutation: ['--dir', '--gate'],
  'mutation-result': ['--dir', '--report'],
  selfcheck: ['--dir', '--all', '--first', '--gate', '--shard', '--quick'],
  lcov: ['--dir', '--file'],
};

/**
 * Reads the argument at `index` into `parsed`.
 * @returns The index of the next argument to read; `argv.length` when nothing is left.
 */
function consume(
  parsed: ParsedArgs,
  argv: string[],
  index: number,
  allowed: string[] | undefined
): number {
  const arg = argv[index] as string;
  const next = index + 1;

  if (arg === '--') {
    if (parsed.command !== 'mutation' && parsed.command !== 'selfcheck') {
      throw new UsageError('"--" is only accepted by the mutation and selfcheck commands');
    }
    parsed.rest.push(...argv.slice(next));
    return argv.length;
  }
  if (arg === '--help' || arg === '-h') {
    parsed.help = true;
    return next;
  }
  if (arg === '--version' || arg === '-v') {
    parsed.version = true;
    return next;
  }

  const equals = arg.indexOf('=');
  const name = equals !== -1 ? arg.slice(0, equals) : arg;
  if (allowed?.includes(name)) {
    if (VALUE_OPTIONS.includes(name)) {
      const value = equals !== -1 ? arg.slice(equals + 1) : argv[next];
      if (value === undefined || value === '') {
        throw new UsageError(`${name} needs a value`);
      }
      if (name === '--gate') {
        parsed.gates.push(value);
      } else if (name === '--shard') {
        if (parsed.shard !== null) {
          throw new UsageError('--shard can be given only once');
        }
        parsed.shard = parseShard(value);
      } else {
        const key = name.slice(2) as 'dir' | 'report' | 'file';
        parsed[key] = value;
      }
      return equals !== -1 ? next : next + 1;
    }
    if (equals !== -1) {
      throw new UsageError(`${name} does not take a value`);
    }
    if (name === '--quick') {
      parsed.quick = true;
      return next;
    }
    const mode = name === '--all' ? 'all' : 'first';
    if (parsed.mode !== null && parsed.mode !== mode) {
      throw new UsageError('--all and --first cannot be combined');
    }
    parsed.mode = mode;
    return next;
  }

  if (parsed.command === 'mutation') {
    parsed.rest.push(arg);
    return next;
  }
  throw new UsageError(
    parsed.command ? `unknown argument for ${parsed.command}: ${arg}` : `unknown argument: ${arg}`
  );
}

/**
 * Parses the command line (without `node` and the script path).
 *
 * `test-gates mutation` forwards what it does not know to Stryker, with or without `--`:
 * `npm run test:gates:mutation -- --force` reaches the script as `test-gates mutation --force`,
 * because npm consumes the separator.
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    command: null,
    help: false,
    version: false,
    dir: '.',
    report: null,
    file: null,
    mode: null,
    gates: [],
    shard: null,
    quick: false,
    rest: [],
  };

  let index = 0;
  const first = argv[0];
  if (first !== undefined && !first.startsWith('-')) {
    if (!(COMMANDS as readonly string[]).includes(first)) {
      throw new UsageError(`unknown command: ${first}`);
    }
    parsed.command = first as Command;
    index = 1;
  }
  const allowed = parsed.command ? OPTIONS_BY_COMMAND[parsed.command] : undefined;

  while (index < argv.length) {
    index = consume(parsed, argv, index, allowed);
  }

  const selections = [
    parsed.mode === null ? null : `--${parsed.mode}`,
    parsed.gates.length > 0 ? '--gate' : null,
    parsed.shard === null ? null : '--shard',
  ].filter((option) => option !== null);
  if (selections.length > 1) {
    throw new UsageError(`${selections.join(' and ')} cannot be combined`);
  }
  // `npm run selfcheck -- --shard 2/4` on a script that already ends in `-- <gate command>`
  // would hand the option to the test runner, which has a --shard of its own.
  const misplaced = parsed.rest.find((arg) => /^--(gate|shard|quick)(=|$)/.test(arg));
  if (parsed.command === 'selfcheck' && misplaced !== undefined) {
    throw new UsageError(
      `${misplaced.split('=')[0]} after "--" would go to the gate command. Write it before "--"`
    );
  }
  // After "--" the option would go to Stryker, which does not know it. (Only mutation is left
  // here with such an argument: selfcheck was refused above, and no other command has a rest.)
  if (parsed.rest.some((arg) => arg === '--gate' || arg.startsWith('--gate='))) {
    throw new UsageError('--gate after "--" would go to Stryker. Write it before "--"');
  }
  if (parsed.command === 'selfcheck' && parsed.rest.length === 0 && argv.includes('--')) {
    throw new UsageError('"--" must be followed by the gate command');
  }
  return parsed;
}
