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
  const record: TouchRecord = { spec, touched };
  fs.mkdirSync(directory, { recursive: true });
  const name = `${createHash('sha256').update(spec).digest('hex')}.json`;
  fs.writeFileSync(path.join(directory, name), JSON.stringify(record));
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

// Vitest has no reporter that sees the coverage of one spec file, so a setup file writes the
// record from inside the worker. After the last hook of the spec: Vitest runs the "after" hooks
// in the reverse order of their registration, and a setup file registers before the spec does.
// The counters are those of the istanbul provider; the v8 provider keeps none in the worker,
// and nothing is written then.
// It is kept as text and written into the touch directory, which lies in the subproject: Vite
// refuses to load a file from outside the project (a package in a node_modules above it).
const VITEST_SETUP = `import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, expect } from 'vitest';

afterAll(() => {
  const directory = process.env.${TOUCH_ENV};
  const spec = expect.getState().testPath;
  const coverage = globalThis.__VITEST_COVERAGE__;
  if (!directory || !spec || typeof coverage !== 'object' || coverage === null) {
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
  const name = createHash('sha256').update(spec).digest('hex') + '.json';
  fs.writeFileSync(path.join(directory, name), JSON.stringify({ spec, touched }));
});
`;

/** Writes the Vitest setup file into the touch directory and returns its path. */
export function vitestSetupFile(directory: string): string {
  const file = path.join(directory, 'vitest-setup.mjs');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(file, VITEST_SETUP);
  return file;
}
