import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Counters, RunInfo, SpecNote } from './core/selfcheck.js';

/**
 * Environment variable through which `test-gates selfcheck` asks the gate run to write down, for
 * each spec file, what it executed of the measured files. The value is a directory. In it:
 *
 * - `run.json`: which runner ran, and how (RunInfo),
 * - `specs/<hash>.json`: the counters of one spec file (SpecNote),
 * - `coverage/coverage-final.json`: the runner's own total, written by its JSON reporter.
 */
export const TOUCH_ENV = 'TEST_GATES_TOUCH_DIR';

/** The counters of one file in a coverage object of istanbul. */
interface FileCoverage {
  s?: Record<string, number>;
  f?: Record<string, number>;
  b?: Record<string, number[]>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The hit counts of one file, in the order of their keys. */
function countersOf(coverage: FileCoverage): Counters {
  return {
    s: Object.values(coverage.s ?? {}),
    f: Object.values(coverage.f ?? {}),
    b: Object.values(coverage.b ?? {}).flat(),
  };
}

/** The counters of every file of an istanbul coverage object; null when it is not one. */
export function countersOfAll(coverage: unknown): Record<string, Counters> | null {
  if (!isObject(coverage)) {
    return null;
  }
  const files: Record<string, Counters> = {};
  for (const [file, counters] of Object.entries(coverage)) {
    if (!isObject(counters)) {
      return null;
    }
    files[file] = countersOf(counters as FileCoverage);
  }
  return files;
}

function add(before: number[], now: number[]): number[] {
  // Two hand-overs for one spec count the same code: the same counters, added up. If they do
  // not line up, a marker that no total can match.
  return before.length === now.length
    ? before.map((count, index) => count + (now[index] ?? 0))
    : [-1];
}

/**
 * Writes what one spec file executed. `coverage` is the istanbul coverage object collected
 * while that spec ran (`path → counters`). A spec that runs more than once (two projects of
 * one runner) has its counts added up.
 */
export function writeSpecNote(directory: string, spec: string, coverage: unknown): void {
  const files = countersOfAll(coverage) ?? {};
  const specs = path.join(directory, 'specs');
  fs.mkdirSync(specs, { recursive: true });
  const file = path.join(specs, `${createHash('sha256').update(spec).digest('hex')}.json`);
  let before: Record<string, Counters> = {};
  try {
    before = (JSON.parse(fs.readFileSync(file, 'utf8')) as SpecNote).files;
  } catch {
    // the first note of this spec
  }
  for (const [name, counters] of Object.entries(before)) {
    const now = files[name];
    files[name] =
      now === undefined
        ? counters
        : { s: add(counters.s, now.s), f: add(counters.f, now.f), b: add(counters.b, now.b) };
  }
  const note: SpecNote = { spec, files };
  fs.writeFileSync(file, JSON.stringify(note));
}

/** Writes how the gate run ran. A later call replaces an earlier one. */
export function writeRunInfo(directory: string, run: RunInfo): void {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'run.json'), JSON.stringify(run));
}

function isCounters(value: unknown): value is Counters {
  return (
    isObject(value) &&
    ['s', 'f', 'b'].every(
      (key) => Array.isArray(value[key]) && value[key].every((count) => typeof count === 'number')
    )
  );
}

/** What the gate run left in the directory. Anything missing or malformed is null. */
export function readNotes(directory: string): {
  run: RunInfo | null;
  notes: SpecNote[] | null;
  totals: Record<string, Counters> | null;
} {
  const read = (file: string): unknown => {
    try {
      return JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8')) as unknown;
    } catch {
      return null;
    }
  };
  const run = read('run.json');
  let notes: SpecNote[] | null = [];
  try {
    for (const name of fs.readdirSync(path.join(directory, 'specs'))) {
      const note = read(path.join('specs', name));
      if (
        !isObject(note) ||
        typeof note.spec !== 'string' ||
        !isObject(note.files) ||
        !Object.values(note.files).every(isCounters)
      ) {
        throw new Error('not a note');
      }
      notes.push(note as unknown as SpecNote);
    }
  } catch {
    notes = null;
  }
  return {
    run:
      isObject(run) &&
      typeof run.runner === 'string' &&
      typeof run.version === 'string' &&
      typeof run.provider === 'string' &&
      typeof run.pool === 'string' &&
      typeof run.isolate === 'boolean' &&
      typeof run.projects === 'number' &&
      (run.problem === null || typeof run.problem === 'string')
        ? (run as unknown as RunInfo)
        : null,
    notes,
    totals: countersOfAll(read(path.join('coverage', 'coverage-final.json'))),
  };
}

/**
 * The Jest reporter next to the module at `moduleUrl`: built (`.cjs`) in the published package,
 * the source when this repository tests itself.
 */
export function jestReporterFile(moduleUrl: string): string {
  const directory = path.dirname(fileURLToPath(moduleUrl));
  const found = ['.cjs', '.ts']
    .map((extension) => path.join(directory, `jest-touch-reporter${extension}`))
    .find((file) => fs.existsSync(file));
  if (found === undefined) {
    throw new Error(`test-gates: jest-touch-reporter is missing in ${directory}`);
  }
  return found;
}

// Vitest has no reporter that sees the coverage of one spec file. What the worker hands over
// after a spec file has run to its very end (every hook, every cleanup function) arrives at the
// coverage provider, in onAfterSuiteRun: the data the thresholds are computed from. This module
// wraps the istanbul provider and writes the note there.
// What it relies on is checked while it runs, and written down as a problem when it is not
// there: the provider has onAfterSuiteRun, and every hand-over names its spec files.
// It is kept as text and written into the touch directory, which lies in the subproject: Vitest
// loads a provider module through Vite, and Vite refuses a file from outside the project.
const VITEST_PROVIDER = `import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import istanbul from '@vitest/coverage-istanbul';

const directory = "__DIRECTORY__";
const run = { runner: 'vitest', version: 'unknown', provider: 'istanbul', pool: 'unknown', isolate: false, projects: 0, problem: null };
const save = () => fs.writeFileSync(path.join(directory, 'run.json'), JSON.stringify(run));
const problem = (text) => {
  run.problem ??= text;
  save();
};

const counts = (coverage) =>
  Object.fromEntries(
    Object.entries(coverage).map(([file, counters]) => [
      file,
      {
        s: Object.values(counters.s ?? {}),
        f: Object.values(counters.f ?? {}),
        b: Object.values(counters.b ?? {}).flat(),
      },
    ])
  );
const add = (before, now) =>
  before.length === now.length ? before.map((count, index) => count + now[index]) : [-1];

function note(spec, files) {
  const file = path.join(directory, 'specs', createHash('sha256').update(spec).digest('hex') + '.json');
  let before = {};
  try {
    before = JSON.parse(fs.readFileSync(file, 'utf8')).files;
  } catch {
    // the first note of this spec
  }
  const merged = { ...files };
  for (const [name, counters] of Object.entries(before)) {
    const now = files[name];
    merged[name] =
      now === undefined
        ? counters
        : { s: add(counters.s, now.s), f: add(counters.f, now.f), b: add(counters.b, now.b) };
  }
  fs.writeFileSync(file, JSON.stringify({ spec, files: merged }));
}

export default {
  ...istanbul,
  async getProvider() {
    const provider = await istanbul.getProvider();
    fs.mkdirSync(path.join(directory, 'specs'), { recursive: true });
    save();
    if (typeof provider.onAfterSuiteRun !== 'function' || typeof provider.initialize !== 'function') {
      problem('the coverage provider of this Vitest has no onAfterSuiteRun or no initialize');
      return provider;
    }
    const initialize = provider.initialize.bind(provider);
    provider.initialize = (ctx) => {
      const config = ctx?.config ?? {};
      const pool = typeof config.pool === 'string' ? config.pool : 'unknown';
      run.version = typeof ctx?.version === 'string' ? ctx.version : 'unknown';
      run.pool = pool;
      run.isolate = (config.poolOptions?.[pool]?.isolate ?? config.isolate) === true;
      run.projects = Array.isArray(ctx?.projects) ? ctx.projects.length : 0;
      save();
      return initialize(ctx);
    };
    const handOver = provider.onAfterSuiteRun.bind(provider);
    provider.onAfterSuiteRun = (meta) => {
      const coverage = meta?.coverage;
      if (coverage !== undefined && coverage !== null) {
        const specs = meta.testFiles;
        if (typeof coverage !== 'object' || !Array.isArray(specs) || specs.length !== 1 || typeof specs[0] !== 'string') {
          problem('Vitest handed over coverage that is not that of exactly one spec file');
        } else {
          note(specs[0], counts(coverage));
        }
      }
      return handOver(meta);
    };
    return provider;
  },
};
`;

/** Writes the provider module for Vitest into the touch directory and returns its path. */
export function vitestProviderFile(directory: string): string {
  const file = path.join(directory, 'vitest-provider.mjs');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(file, VITEST_PROVIDER.replace('"__DIRECTORY__"', JSON.stringify(directory)));
  return file;
}
