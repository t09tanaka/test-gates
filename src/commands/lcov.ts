import fs from 'node:fs';
import path from 'node:path';
import { judgeLcov, parseLcov, summarizeLcov } from '../core/lcov.js';
import { ManifestError } from '../core/manifest.js';
import type { Violation } from '../core/types.js';
import { existsExact } from '../fs.js';
import { readManifest } from '../load.js';
import { type Io, printViolations } from './output.js';

/** Per-file 100% line coverage from an lcov tracefile, for stacks without mutation testing. */
export function runLcov(dir: string, fileOption: string | null, io: Io): number {
  const manifest = readManifest(dir);
  const file = fileOption ?? manifest.settings.lcovFile;
  if (file === null) {
    throw new ManifestError(
      'no lcov file given. Pass --file <lcov.info> or set settings.lcov.file'
    );
  }
  const lcovPath = path.resolve(manifest.dir, file);
  let text: string;
  try {
    text = fs.readFileSync(lcovPath, 'utf8');
  } catch (error) {
    io.err(
      `sekisho lcov: cannot read ${file} (${(error as Error).message}). Run the tests with coverage first`
    );
    return 1;
  }

  const violations: Violation[] = [...manifest.violations];
  const existing = manifest.gates.filter((gate) => {
    const exists = existsExact(manifest.dir, gate.path);
    if (!exists) {
      violations.push({
        file: gate.path,
        message: 'file not found (the check is case-sensitive). Update test-gates.json if it moved',
      });
    }
    return exists;
  });

  const coverage = parseLcov(text, manifest.dir);
  const total = summarizeLcov(coverage, manifest.settings.lcovSummaryExclude);
  io.out(
    total.found === 0
      ? 'reference: no instrumented lines in the lcov file'
      : `reference: overall line coverage ${((total.hit / total.found) * 100).toFixed(2)}% (${total.hit}/${total.found}, not gated)`
  );

  const verdict = judgeLcov(
    existing.map((gate) => gate.path),
    coverage
  );
  for (const result of verdict.results) {
    if (result.ok) {
      io.out(`  ✓ ${result.path}: ${result.hit}/${result.found} lines`);
    }
  }
  violations.push(...verdict.violations);
  if (violations.length > 0) {
    printViolations(io, 'lcov', violations);
    return 1;
  }
  io.out(`sekisho lcov: OK (${verdict.results.length} gate(s) at 100% line coverage)`);
  return 0;
}
