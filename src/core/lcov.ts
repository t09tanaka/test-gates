import type { Violation } from './types.js';

export interface LcovFile {
  /** Instrumented lines. */
  found: number;
  /** Instrumented lines executed at least once. */
  hit: number;
  /** Instrumented lines never executed, ascending. Empty when the record has no DA entries. */
  uncovered: number[];
}

interface Accumulator {
  lines: Map<number, number>;
  found: number;
  hit: number;
}

function normalizePath(file: string, rootDir?: string): string {
  let normalized = file.trim().replace(/\\/g, '/');
  if (rootDir !== undefined) {
    const root = rootDir.replace(/\\/g, '/').replace(/\/+$/, '');
    if (normalized.startsWith(`${root}/`)) {
      normalized = normalized.slice(root.length + 1);
    }
  }
  return normalized.replace(/^\.\//, '');
}

/**
 * Reads an lcov tracefile into per-file line coverage.
 *
 * When a file appears in several records (merged tracefiles), lines are united through their
 * `DA:` entries, so a line counts as hit if any record hit it. A record without `DA:` entries
 * contributes its `LF:` / `LH:` totals instead.
 *
 * @param rootDir When given, absolute `SF:` paths under it are made relative to it.
 */
export function parseLcov(text: string, rootDir?: string): Map<string, LcovFile> {
  const files = new Map<string, Accumulator>();
  let current: Accumulator | null = null;
  let recordHasDa = false;
  let recordFound = 0;
  let recordHit = 0;

  const closeRecord = () => {
    if (current && !recordHasDa) {
      current.found += recordFound;
      current.hit += recordHit;
    }
    current = null;
  };

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line.startsWith('SF:')) {
      closeRecord();
      const file = normalizePath(line.slice(3), rootDir);
      current = files.get(file) ?? { lines: new Map(), found: 0, hit: 0 };
      files.set(file, current);
      recordHasDa = false;
      recordFound = 0;
      recordHit = 0;
    } else if (line === 'end_of_record') {
      closeRecord();
    } else if (current) {
      if (line.startsWith('DA:')) {
        const [lineNumber, hits] = line.slice(3).split(',');
        const number = Number(lineNumber);
        const count = Number(hits);
        if (Number.isInteger(number) && Number.isFinite(count)) {
          recordHasDa = true;
          current.lines.set(number, Math.max(current.lines.get(number) ?? 0, count));
        }
      } else if (line.startsWith('LF:')) {
        recordFound = Number(line.slice(3)) || 0;
      } else if (line.startsWith('LH:')) {
        recordHit = Number(line.slice(3)) || 0;
      }
    }
  }
  closeRecord();

  const result = new Map<string, LcovFile>();
  for (const [file, accumulator] of files) {
    const uncovered = [...accumulator.lines.entries()]
      .filter(([, hits]) => hits <= 0)
      .map(([lineNumber]) => lineNumber)
      .sort((a, b) => a - b);
    result.set(file, {
      found: accumulator.lines.size + accumulator.found,
      hit: accumulator.lines.size - uncovered.length + accumulator.hit,
      uncovered,
    });
  }
  return result;
}

export interface LcovGateResult {
  path: string;
  found: number;
  hit: number;
  ok: boolean;
}

export interface LcovVerdict {
  violations: Violation[];
  results: LcovGateResult[];
}

/**
 * Requires 100% line coverage for every gate. A gate with no record (never loaded by a test)
 * or with no instrumented line fails: an absent measurement is not a pass.
 */
export function judgeLcov(gatePaths: string[], coverage: Map<string, LcovFile>): LcovVerdict {
  const violations: Violation[] = [];
  const results: LcovGateResult[] = [];
  for (const gatePath of gatePaths) {
    const file = coverage.get(normalizePath(gatePath));
    if (!file) {
      violations.push({ file: gatePath, message: 'no record in the lcov file' });
      results.push({ path: gatePath, found: 0, hit: 0, ok: false });
      continue;
    }
    if (file.found === 0) {
      violations.push({ file: gatePath, message: 'no instrumented lines in the lcov record' });
      results.push({ path: gatePath, found: 0, hit: 0, ok: false });
      continue;
    }
    const ok = file.hit === file.found;
    if (!ok) {
      const shown = file.uncovered.slice(0, 20).join(', ');
      const more = file.uncovered.length > 20 ? ', …' : '';
      violations.push({
        file: gatePath,
        ...(file.uncovered[0] === undefined ? {} : { line: file.uncovered[0] }),
        message:
          `${file.hit}/${file.found} lines covered` +
          (shown === '' ? '' : ` (uncovered: ${shown}${more})`),
      });
    }
    results.push({ path: gatePath, found: file.found, hit: file.hit, ok });
  }
  return { violations, results };
}

/** Total line coverage over the records whose path matches none of `exclude`. Reference only. */
export function summarizeLcov(
  coverage: Map<string, LcovFile>,
  exclude: RegExp[]
): { found: number; hit: number } {
  let found = 0;
  let hit = 0;
  for (const [file, lines] of coverage) {
    if (exclude.some((regex) => regex.test(file))) {
      continue;
    }
    found += lines.found;
    hit += lines.hit;
  }
  return { found, hit };
}
