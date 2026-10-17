import { withoutDots } from './affected.js';
// `test-gates selfcheck --jobs <n>`: several negative controls at the same time.
//
// A control that runs next to others is taken only when its run shows, in the runner's own
// words, that nothing but the threshold of its gate went wrong (cleanHold). Every other control
// is run again on its own, and that run counts. What a run next to others cannot show is a spec
// that quietly does something else because another run is there: one that finds a file, a port
// or a lock taken, or that looks at the time, and then covers less of another gate. So the
// controls are only started at the same time when the gate command and config are known
// (jobsRefused), and a control only when no spec in its run that loads its gate, and no file the
// gate config names, can be seen to reach outside of its process (jobsPlan).

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
  const rest = runner === 'vitest' ? args.slice(1) : [...args];
  let configs = 0;
  for (let arg = rest.shift(); arg !== undefined; arg = rest.shift()) {
    if (SWITCHES[runner].includes(arg)) {
      continue;
    }
    const equals = arg.indexOf('=');
    const name = equals === -1 ? arg : arg.slice(0, equals);
    // The value is in the same word (`--config=x`) or is the next one.
    const value = equals === -1 ? rest.shift() : arg.slice(equals + 1);
    if (value !== undefined && (name === '--config' || name === '-c')) {
      configs += 1;
    } else if (!COUNTS[runner].includes(name) || !COUNT.test(String(value))) {
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

// Options of the gate command that set how many workers a run may use. `--ci` and `--pool`
// do not.
const LIMITS: Record<Runner, string[]> = {
  jest: ['--runInBand', '-i', '--maxWorkers', '-w'],
  vitest: ['--no-file-parallelism', '--fileParallelism', '--maxWorkers', '--minWorkers'],
};
// Words of a gate config that set how many workers a run may use.
const CONFIG_LIMITS = [
  'maxWorkers',
  'minWorkers',
  'maxThreads',
  'minThreads',
  'maxForks',
  'minForks',
  'fileParallelism',
  'singleThread',
  'singleFork',
];

/**
 * What is added to the gate command of a run next to others, so that the runs together use
 * about as many workers as the machine has cores. Each runner takes about one worker per core
 * for a run of its own, and `lines` runs at once would take `lines` times that.
 *
 * @param input.args The gate command after the program, as knownCommand accepted it.
 * @param input.configSource Text of the gate config; null when it cannot be read.
 * @param input.lines How many runs are under way at the same time.
 * @param input.cores What `os.availableParallelism()` says.
 * @returns Nothing when one run is under way at a time, or when the gate command or the gate
 *   config already says how many workers a run may use: that is kept as it is.
 */
export function workerFlags(input: {
  runner: Runner;
  args: string[];
  configSource: string | null;
  lines: number;
  cores: number;
}): string[] {
  if (input.lines <= 1) {
    return [];
  }
  const given = input.args.some((arg) =>
    LIMITS[input.runner].includes(arg.split('=')[0] as string)
  );
  const configured = CONFIG_LIMITS.some((word) => input.configSource?.includes(word) === true);
  if (given || configured) {
    return [];
  }
  return [`--maxWorkers=${Math.max(1, Math.floor(input.cores / input.lines))}`];
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
  'global.',
  'global[',
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
// A module that is named by an expression cannot be followed, and neither can `require` once it
// is handed on under another name.
const COMPUTED_LOAD =
  /(?:require|import)\((?!['"])|\brequire(?!\(|\.resolve\b|[\w$])|\bimport\.meta\.glob\b/;
const COMPUTED = 'loads a module whose name is computed';
// A string in quotes that surely is one: it opens where a value starts, closes on its line, and
// a value may end right after it. Its text is not code: `"retry: {count}"` in a file of
// messages uses nothing. A quote that may be something else (in a regular expression, in a
// comment) seldom has a place where a value starts before it and one where it ends after it,
// and when it does not, nothing is taken out. Nor is the inside of one that holds `${`.
const STRING = /(^|[:,([={?+&|;])(\s*)(['"])((?:\\.|(?!\3)[^\\\n])*)\3(?=\s*(?:[,}\]);:+?&|]|$))/gm;

/** The text with the inside of each string in quotes (see STRING) left blank. */
export function withoutStrings(source: string): string {
  return source.replace(
    STRING,
    (all: string, before: string, space: string, quote: string, inside: string) =>
      // In a template (`{"home": "${home()}"}`) the quotes are text, and what is
      // between them may be code.
      inside.includes('${') ? all : `${before}${space}${quote}${' '.repeat(inside.length)}${quote}`
  );
}
const RUNNER_PACKAGES = ['vitest', '@jest/globals'];

/**
 * What a file a gate run loads does that could make it meet another run, or null when nothing
 * of the kind is seen in it. By its text: a comment that names `setTimeout` counts as a use,
 * the text of a string in quotes does not (withoutStrings).
 *
 * Packages are not looked into, so only the runner's own and those in `trusted` may be
 * imported.
 *
 * @param trusted Names of packages the project vouches for (a subpath is trusted with its
 *   package).
 */
export function reachesOutside(file: LoadedFile, trusted: string[]): string | null {
  const dense = file.source.replace(/\s/g, '');
  const code = withoutStrings(file.source).replace(/\s/g, '');
  const mark = REACHES.find((text) => code.includes(text));
  if (mark !== undefined) {
    return `uses ${mark.replace(/[.?[(:]+$/, '')}`;
  }
  if (COMPUTED_LOAD.test(dense)) {
    return COMPUTED;
  }
  for (const { specifier, builtin } of file.imports) {
    // Also one that only computes: with Jest the spec files of a worker share the objects of
    // the built-in modules, and a setting changed on one of them is seen by the next spec.
    if (builtin) {
      return `imports ${specifier}`;
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
 * when they can be, as far as the gate command and config tell. Which of them can is then up to
 * the files their runs load (jobsPlan).
 *
 * @param input.command What knownCommand says of the gate command.
 * @param input.configSource Text of the gate config the gate command names; null when it
 *   cannot be read.
 */
export function jobsRefused(input: {
  failurePattern: string | null;
  command: { runner: Runner } | { stray: string };
  configSource: string | null;
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
  return null;
}

/**
 * Where the files of a gate run come from: the spec of a gate, or what the gate config names (a
 * setup file runs with every spec), with all the project files they import.
 */
export interface LoadRoot {
  /** The spec, relative to the subproject; null for the files the gate config names. */
  spec: string | null;
  /** Paths of every file it loads, itself among them (see LoadedFile.path). */
  files: string[];
  /** The first of its imports that leads to no file and to no installed package, or null. */
  lost: string | null;
}

/**
 * Which of the negative controls may run next to others, and why each of the others may not.
 *
 * A control leaves out the spec of its gate and runs every other spec. What a spec does
 * differently while another run is there can only change the control of a gate that the spec
 * covers, and a spec can only cover a gate it loads. So the control of a gate runs on its own
 * when, in its run, something that loads the gate (or may load it) also loads a file that reaches
 * outside of its process (reachesOutside):
 *
 * - a spec other than the gate's own that imports the gate, directly or through other files,
 *   and among whose files one reaches outside;
 * - a spec other than the gate's own whose imports cannot all be followed, or among whose files
 *   one loads a module whose name is computed: it may load any gate;
 * - the files the gate config names, when one of them reaches outside or cannot be followed:
 *   they run with every spec.
 *
 * A spec that reaches outside but loads no other gate (the usual spec of a gate: the gate and
 * fixed values) does not keep any control from running next to others.
 *
 * @param input.gates The controls to run: the path of each gate and of its spec.
 * @param input.files Every file of the roots (see LoadedFile).
 * @param input.trusted Packages the project vouches for (see reachesOutside).
 * @returns `alone`: the controls that run on their own, in the order of `gates`. `causes`: for
 *   every root that keeps controls from running next to others, which ones and why, in the
 *   order of `roots`.
 */
export function jobsPlan(input: {
  gates: { path: string; spec: string }[];
  files: LoadedFile[];
  roots: LoadRoot[];
  trusted: string[];
}): { atOnce: string[]; alone: string[]; causes: { gates: string[]; reason: string }[] } {
  const byPath = new Map(input.files.map((file) => [file.path, file]));
  const causes = input.roots.flatMap((root) => {
    const loaded = root.files.flatMap((name) => {
      const file = byPath.get(name);
      return file === undefined ? [] : [file];
    });
    let computed = false;
    const reaches = loaded.flatMap((file) => {
      const reach = reachesOutside(file, input.trusted);
      const said = reach === null ? [] : [`${file.path} ${reach}`];
      if (!COMPUTED_LOAD.test(file.source.replace(/\s/g, ''))) {
        return said;
      }
      computed = true;
      // (said first when the file also uses something of REACHES)
      return reach === COMPUTED ? said : [...said, `${file.path} ${COMPUTED}`];
    });
    const reasons = [
      ...(root.lost === null ? [] : [`${root.lost} cannot be followed`]),
      ...reaches,
    ];
    if (reasons.length === 0) {
      return [];
    }
    // What the gate config names runs with every spec, and a spec of which not all that it loads
    // is known may load any gate.
    const any = root.spec === null || root.lost !== null || computed;
    const gates = input.gates
      .filter(
        (gate) => gate.spec !== root.spec && (any || root.files.includes(withoutDots(gate.path)))
      )
      .map((gate) => gate.path);
    const by =
      root.spec === null
        ? 'run with what the gate config names'
        : `${any ? 'maybe loaded' : 'loaded'} by ${root.spec}`;
    return gates.length === 0 ? [] : [{ gates, reason: `${by}, in which ${reasons.join('; ')}` }];
  });
  const kept = new Set(causes.flatMap((cause) => cause.gates));
  const paths = input.gates.map((gate) => gate.path);
  return {
    atOnce: paths.filter((gate) => !kept.has(gate)),
    alone: paths.filter((gate) => kept.has(gate)),
    causes,
  };
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
  const words = line.toLowerCase().split(/[^a-z]/);
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
      // What stands around the names of the project, piece by piece.
      !input.names
        .reduce((pieces, name) => pieces.flatMap((piece) => piece.split(name)), [line])
        .some(troubled)
    );
  });
}
