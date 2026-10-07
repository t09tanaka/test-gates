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
  /**
   * mutation: arguments handed to Stryker. selfcheck: the gate command to run instead of the
   * configured one.
   */
  rest: string[];
}

export class UsageError extends Error {}

const VALUE_OPTIONS = ['--dir', '--report', '--file'];

const OPTIONS_BY_COMMAND: Record<Command, string[]> = {
  check: ['--dir'],
  mutation: ['--dir'],
  'mutation-result': ['--dir', '--report'],
  selfcheck: ['--dir', '--all', '--first'],
  lcov: ['--dir', '--file'],
};

/**
 * Parses the command line (without `node` and the script path).
 *
 * `sekisho mutation` forwards what it does not know to Stryker, with or without `--`:
 * `npm run test:gates:mutation -- --force` reaches the script as `sekisho mutation --force`,
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
  const allowed = parsed.command ? OPTIONS_BY_COMMAND[parsed.command] : [];

  while (index < argv.length) {
    const arg = argv[index] as string;
    index += 1;

    if (arg === '--') {
      if (parsed.command !== 'mutation' && parsed.command !== 'selfcheck') {
        throw new UsageError('"--" is only accepted by the mutation and selfcheck commands');
      }
      parsed.rest.push(...argv.slice(index));
      break;
    }
    if (arg === '--help' || arg === '-h') {
      parsed.help = true;
      continue;
    }
    if (arg === '--version' || arg === '-v') {
      parsed.version = true;
      continue;
    }

    const equals = arg.indexOf('=');
    const name = arg.startsWith('--') && equals !== -1 ? arg.slice(0, equals) : arg;
    if (allowed.includes(name)) {
      if (VALUE_OPTIONS.includes(name)) {
        let value: string | undefined;
        if (equals !== -1) {
          value = arg.slice(equals + 1);
        } else {
          value = argv[index];
          index += 1;
        }
        if (value === undefined || value === '') {
          throw new UsageError(`${name} needs a value`);
        }
        const key = name.slice(2) as 'dir' | 'report' | 'file';
        parsed[key] = value;
        continue;
      }
      if (equals !== -1) {
        throw new UsageError(`${name} does not take a value`);
      }
      const mode = name === '--all' ? 'all' : 'first';
      if (parsed.mode !== null && parsed.mode !== mode) {
        throw new UsageError('--all and --first cannot be combined');
      }
      parsed.mode = mode;
      continue;
    }

    if (parsed.command === 'mutation') {
      parsed.rest.push(arg);
      continue;
    }
    throw new UsageError(
      parsed.command ? `unknown argument for ${parsed.command}: ${arg}` : `unknown argument: ${arg}`
    );
  }

  if (parsed.command === 'selfcheck' && parsed.rest.length === 0 && argv.includes('--')) {
    throw new UsageError('"--" must be followed by the gate command');
  }
  return parsed;
}
