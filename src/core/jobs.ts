// `test-gates selfcheck --jobs <n>`: several negative controls at the same time.
//
// A control that runs next to others is taken only when its run shows, in the runner's own
// words, that nothing but the threshold of its gate went wrong (cleanHold). Every other control
// is run again on its own, and that run counts. What a run next to others cannot show is a spec
// that quietly does something else because another run is there: one that finds a file, a port
// or a lock taken, or that looks at the time. So the controls are only started at the same time
// when no file a gate run loads can be seen to reach outside of its process (jobsRefused).

/** The runners whose gate command and output are known. */
export type Runner = 'jest' | 'vitest';

// Options of the gate command that only say how many workers a run uses.
const SWITCHES: Record<Runner, string[]> = {
  jest: ['--runInBand', '-i', '--ci'],
  vitest: ['--no-file-parallelism', '--fileParallelism=false', '--pool=forks', '--pool=threads'],
};
const COUNTS: Record<Runner, string[]> = {
  jest: ['--maxWorkers', '-w'],
  vitest: ['--maxWorkers', '--minWorkers'],
};
const COUNT = /^\d+%?$/;

/**
 * Says whether the gate command is one whose every argument is known: the runner, the gate
 * config, and at most options for the number of workers. Any other argument may send what the
 * run writes somewhere this command does not know of (`--coverage.reportsDirectory`), or change
 * what is run.
 *
 * @returns The runner, or in `stray` the first word that is not known.
 */
export function knownCommand(
  program: string,
  args: string[]
): { runner: Runner } | { stray: string } {
  const runner = (['jest', 'vitest'] as const).find((name) => name === program);
  if (runner === undefined) {
    return { stray: program };
  }
  if (runner === 'vitest' && args[0] !== 'run') {
    return { stray: args[0] ?? 'vitest without "run"' };
  }
  const rest = runner === 'vitest' ? args.slice(1) : args;
  let configs = 0;
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index] as string;
    if (SWITCHES[runner].includes(arg)) {
      continue;
    }
    const equals = arg.indexOf('=');
    const name = equals === -1 ? arg : arg.slice(0, equals);
    // The value is in the same word (`--config=x`) or is the next one.
    const value = equals === -1 ? rest[index + 1] : arg.slice(equals + 1);
    if (equals === -1) {
      index += 1;
    }
    if (value !== undefined && (name === '--config' || name === '-c')) {
      configs += 1;
    } else if (value === undefined || !COUNTS[runner].includes(name) || !COUNT.test(value)) {
      return { stray: arg };
    }
  }
  return configs === 1 ? { runner } : { stray: configs === 0 ? 'no --config' : 'two --config' };
}

/**
 * What is added to the gate command of a run next to others, so that it writes nowhere another
 * run reads: the directory of the coverage tool (Vitest keeps the coverage of each spec file
 * there until the run ends, and empties it when it starts) and the runner's cache. On the
 * command line, because that wins over whatever the gate config says.
 *
 * @param dir A directory no other run uses at the same time.
 */
export function jobFlags(runner: Runner, dir: string): string[] {
  return runner === 'jest'
    ? [`--coverageDirectory=${dir}/coverage`, `--cacheDirectory=${dir}/cache`]
    : [`--coverage.reportsDirectory=${dir}/coverage`, '--no-cache'];
}

/** A file that a gate run loads: a spec, a setup file, a gate, and everything they import. */
export interface LoadedFile {
  /** Path relative to the subproject. */
  path: string;
  source: string;
  /** Its runtime imports that are not files of the project, as they are written. */
  imports: { specifier: string; builtin: boolean }[];
}

// Written in a file, these say that it looks at something its process shares with others, or
// at something that depends on how busy the machine is: the environment, the clock, a wait,
// the network, the memory. Searched in the text without its whitespace.
const REACHES = [
  'process.',
  'process?.',
  'process[',
  'globalThis',
  'import.meta.env',
  'Date.now',
  'Date()',
  'performance.now',
  'setTimeout',
  'setInterval',
  'setImmediate',
  'waitFor',
  'waitUntil',
  'expect.poll',
  'retryTimes',
  'retry:',
  'fetch(',
  'WebSocket',
  'XMLHttpRequest',
  'navigator',
  'Atomics',
  'WeakRef',
  'FinalizationRegistry',
  'eval(',
  'Function(',
];
// A module that is named by an expression cannot be followed.
const COMPUTED_LOAD = /(?:require|import)\((?!['"])/;
// Built-in modules that only compute.
const QUIET_BUILTINS = [
  'assert',
  'assert/strict',
  'buffer',
  'events',
  'path',
  'path/posix',
  'path/win32',
  'querystring',
  'string_decoder',
  'url',
  'util',
  'util/types',
];
const RUNNER_PACKAGES = ['vitest', '@jest/globals'];

/**
 * What a file a gate run loads does that could make it meet another run, or null when nothing
 * of the kind is seen in it. By its text: a comment that names `setTimeout` counts as a use.
 *
 * Packages are not looked into, so only the runner's own and those in `trusted` may be
 * imported.
 *
 * @param trusted Names of packages the project vouches for (a subpath is trusted with its
 *   package).
 */
export function reachesOutside(file: LoadedFile, trusted: string[]): string | null {
  const dense = file.source.replace(/\s+/g, '');
  const mark = REACHES.find((text) => dense.includes(text));
  if (mark !== undefined) {
    return `uses ${mark.replace(/[.?[(:]+$/, '')}`;
  }
  if (COMPUTED_LOAD.test(dense)) {
    return 'loads a module whose name is computed';
  }
  for (const { specifier, builtin } of file.imports) {
    if (builtin) {
      if (!QUIET_BUILTINS.includes(specifier.replace(/^node:/, ''))) {
        return `imports ${specifier}`;
      }
    } else if (
      ![...RUNNER_PACKAGES, ...trusted].some(
        (name) => specifier === name || specifier.startsWith(`${name}/`)
      )
    ) {
      return `imports the package ${specifier}, which is not looked into`;
    }
  }
  return null;
}

/**
 * Why the negative controls are not run at the same time although `--jobs` asks for it, or null
 * when they can be.
 *
 * @param input.command What knownCommand says of the gate command.
 * @param input.configSource Text of the gate config the gate command names; null when it
 *   cannot be read.
 * @param input.lost An import of a loaded file that could not be followed, or null.
 * @param input.files Every file a gate run loads, as far as the imports could be followed.
 * @param input.trusted Packages the project vouches for (see reachesOutside).
 */
export function jobsRefused(input: {
  failurePattern: string | null;
  command: { runner: Runner } | { stray: string };
  configSource: string | null;
  lost: string | null;
  files: LoadedFile[];
  trusted: string[];
}): string | null {
  // (An empty pattern counts as none, as it does for the judge.)
  if (input.failurePattern) {
    return 'with settings.selfcheck.failurePattern, a run that was disturbed cannot be told from one that was not';
  }
  if ('stray' in input.command) {
    return `the gate command is not known to keep runs at the same time apart: only jest or "vitest run" with --config and options for the number of workers is (found: ${input.command.stray})`;
  }
  const helper =
    input.command.runner === 'jest' ? 'createJestGatesConfig' : 'createVitestGatesConfig';
  if (input.configSource === null || !input.configSource.includes(helper)) {
    return `the gate config does not use ${helper}`;
  }
  if (input.lost !== null) {
    return `${input.lost} cannot be followed, so what the gate run loads is not known`;
  }
  for (const file of input.files) {
    const reach = reachesOutside(file, input.trusted);
    if (reach !== null) {
      return `${file.path} ${reach}, and may meet what another run is doing`;
    }
  }
  return null;
}

// Words a gate run prints when something went wrong besides a threshold (a failed, skipped or
// timed-out test, an error, a process that was lost), in lower case.
const TROUBLE = [
  'fail',
  'fails',
  'failed',
  'failing',
  'failure',
  'failures',
  'err',
  'timeout',
  'timeouts',
  'timed',
  'unhandled',
  'uncaught',
  'killed',
  'terminated',
  'crashed',
  'aborted',
  'skipped',
  'todo',
  'retry',
  'retried',
  'obsolete',
  'sigkill',
  'sigterm',
  'sigabrt',
  'sigsegv',
  'sigint',
];
const TROUBLE_SIGNS = ['✗', '×', '✕', '✖'];

function troubled(line: string): boolean {
  const words = line.toLowerCase().match(/[a-z]+/g) ?? [];
  return (
    // (`TypeError`, `errors`)
    words.some((word) => TROUBLE.includes(word) || /errors?$/.test(word)) ||
    TROUBLE_SIGNS.some((sign) => line.includes(sign))
  );
}

/** The line without the escape sequences that colour it. */
function plain(line: string): string {
  return line
    .split('\u001b[')
    .map((part, index) => (index === 0 ? part : part.slice(part.indexOf('m') + 1)))
    .join('')
    .trim();
}

// The two lines in which each runner sums up a run, and how they read when every spec file and
// every test passed and none was skipped.
const SUMMARY: Record<Runner, { files: string; tests: string; all: (count: string) => string }> = {
  jest: {
    files: 'Test Suites:',
    tests: 'Tests:',
    all: (count) => `${count} passed, ${count} total`,
  },
  vitest: { files: 'Test Files', tests: 'Tests', all: (count) => `${count} passed (${count})` },
};

/**
 * Decides whether a negative control that ran at the same time as others can be taken as it
 * is. Under load a test can time out, be skipped or lose its process, and such a run can look
 * like a control that held. So more is asked than of a run on its own:
 *
 * - the control held (judgeSelfcheck) and the process ended by itself;
 * - the runner sums the run up as: every spec file but the one left out, all passed, and every
 *   test passed (a run with a reporter that prints no such lines is not taken);
 * - every threshold the run reports is that of this gate and of no other;
 * - no other line speaks of a failure.
 *
 * Anything less, and the control is run again on its own, and that result counts.
 *
 * @param input.held Whether judgeSelfcheck takes the run as a control that held.
 * @param input.signal The signal that ended the process, or null.
 * @param input.specs Number of spec files the run has to report: all but the one left out.
 * @param input.others Paths of the other gates.
 * @param input.names Paths that are not read as words of the runner: a gate may be called
 *   `errors.ts`. The longest first.
 */
export function cleanHold(input: {
  held: boolean;
  signal: string | null;
  output: string;
  runner: Runner;
  specs: number;
  gatePath: string;
  others: string[];
  names: string[];
}): boolean {
  const { output, gatePath, others } = input;
  if (!input.held || input.signal !== null) {
    return false;
  }
  const lines = output.split('\n').map(plain);
  const summary = SUMMARY[input.runner];
  const after = (label: string) =>
    lines.filter((line) => line.startsWith(label)).map((line) => line.slice(label.length).trim());
  const files = after(summary.files);
  // (`Tests` also begins the line of the files of Vitest: `Test Files` does not begin with it.)
  const tests = after(summary.tests);
  const count = (tests[0] ?? '').split(' ')[0] as string;
  if (
    files.length !== 1 ||
    files[0] !== summary.all(String(input.specs)) ||
    tests.length !== 1 ||
    !/^\d+$/.test(count) ||
    tests[0] !== summary.all(count)
  ) {
    return false;
  }
  return lines.every((line) => {
    const lower = line.toLowerCase();
    if (lower.includes('threshold') || lower.includes('coverage data for')) {
      return line.includes(gatePath) && !others.some((other) => line.includes(other));
    }
    // A row of the coverage table names a file, and only that.
    return (
      line.split('|').length >= 5 ||
      !troubled(input.names.reduce((rest, name) => rest.split(name).join(''), line))
    );
  });
}
