import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Environment variable through which `test-gates selfcheck` asks the gate run to write down, for
 * each spec file, which measured files it executed anything of. The value is a directory.
 */
export const TOUCH_ENV = 'TEST_GATES_TOUCH_DIR';

/** What one spec file executed, as the coverage tool counted it. */
export interface TouchRecord {
  /** Absolute path of the spec file. */
  spec: string;
  /** Absolute paths of the measured files in which the spec executed at least one counter. */
  touched: string[];
}

/** The counters of one file in a coverage object of istanbul. */
interface FileCoverage {
  s?: Record<string, number>;
  f?: Record<string, number>;
  b?: Record<string, number[]>;
}

/**
 * Writes the record of one spec file. `coverage` is the istanbul coverage object collected
 * while that spec ran (`path → counters`). Without one nothing is written: a spec without a
 * record makes `selfcheck` fall back to one run per gate.
 */
export function writeTouchRecord(directory: string, spec: string, coverage: unknown): void {
  if (typeof coverage !== 'object' || coverage === null) {
    return;
  }
  const touched = Object.entries(coverage as Record<string, FileCoverage>)
    .filter(([, counters]) =>
      [
        ...Object.values(counters.s ?? {}),
        ...Object.values(counters.f ?? {}),
        ...Object.values(counters.b ?? {}).flat(),
      ].some((count) => count > 0)
    )
    .map(([file]) => file);
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `${createHash('sha256').update(spec).digest('hex')}.json`);
  // The same spec may run more than once (two projects of one runner): keep what each run touched.
  let before: string[] = [];
  try {
    before = (JSON.parse(fs.readFileSync(file, 'utf8')) as TouchRecord).touched;
  } catch {
    // the first record of this spec
  }
  const record: TouchRecord = { spec, touched: [...new Set([...before, ...touched])] };
  fs.writeFileSync(file, JSON.stringify(record));
}

/** Every record in the directory; an empty list when there is none or one cannot be read. */
export function readTouchRecords(directory: string): TouchRecord[] {
  try {
    return fs
      .readdirSync(directory)
      .filter((name) => name.endsWith('.json'))
      .map((name) => {
        const record = JSON.parse(
          fs.readFileSync(path.join(directory, name), 'utf8')
        ) as TouchRecord;
        if (typeof record.spec !== 'string' || !Array.isArray(record.touched)) {
          throw new Error('not a record');
        }
        return record;
      });
  } catch {
    return [];
  }
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
// wraps the istanbul provider and writes the record there. With modules shared between spec
// files one hand-over can belong to several files; each of them then gets all of it, which says
// "touched" too often, never too rarely.
// It is kept as text and written into the touch directory, which lies in the subproject: Vitest
// loads a provider module through Vite, and Vite refuses a file from outside the project.
const VITEST_PROVIDER = `import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import istanbul from '@vitest/coverage-istanbul';

const directory = ${JSON.stringify('__DIRECTORY__')};

function note(spec, coverage) {
  if (typeof coverage !== 'object' || coverage === null) {
    return;
  }
  const touched = Object.entries(coverage)
    .filter(([, counters]) =>
      [
        ...Object.values(counters.s ?? {}),
        ...Object.values(counters.f ?? {}),
        ...Object.values(counters.b ?? {}).flat(),
      ].some((count) => count > 0)
    )
    .map(([file]) => file);
  const file = path.join(directory, createHash('sha256').update(spec).digest('hex') + '.json');
  let before = [];
  try {
    before = JSON.parse(fs.readFileSync(file, 'utf8')).touched;
  } catch {
    // the first record of this spec
  }
  fs.writeFileSync(file, JSON.stringify({ spec, touched: [...new Set([...before, ...touched])] }));
}

export default {
  ...istanbul,
  async getProvider() {
    const provider = await istanbul.getProvider();
    const handOver = provider.onAfterSuiteRun.bind(provider);
    provider.onAfterSuiteRun = (meta) => {
      for (const spec of meta.testFiles ?? []) {
        note(spec, meta.coverage);
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
