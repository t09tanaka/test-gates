import fs from 'node:fs';
import path from 'node:path';
import {
  formatSummary,
  formatSurvivor,
  judgeMutationReport,
  type MutationReport,
} from '../core/mutation-result.js';
import { readManifest, type LoadedManifest } from '../load.js';
import { type Io, printViolations } from './output.js';

export function reportPathOf(manifest: LoadedManifest, override: string | null): string {
  return path.resolve(manifest.dir, override ?? manifest.settings.strykerReportFile);
}

export function runMutationResult(dir: string, reportOverride: string | null, io: Io): number {
  const manifest = readManifest(dir);
  const reportPath = reportPathOf(manifest, reportOverride);
  const shown = path.relative(manifest.dir, reportPath) || reportPath;

  let report: MutationReport;
  try {
    report = JSON.parse(fs.readFileSync(reportPath, 'utf8')) as MutationReport;
  } catch (error) {
    io.err(
      `test-gates mutation: cannot read the Stryker JSON report ${shown} (${(error as Error).message}). ` +
        'Did Stryker finish, with the "json" reporter writing to this path?'
    );
    return 1;
  }
  if (typeof report !== 'object' || report === null) {
    io.err(`test-gates mutation: ${shown} is not a Stryker JSON report`);
    return 1;
  }

  const verdict = judgeMutationReport({
    gates: manifest.gates,
    report,
    readSource: (gatePath) => {
      try {
        return fs.readFileSync(path.join(manifest.dir, gatePath), 'utf8');
      } catch {
        return undefined;
      }
    },
  });
  const summary = formatSummary(verdict.summary);

  if (verdict.violations.length === 0 && verdict.survivors.length === 0) {
    io.out(`test-gates mutation: OK (${summary})`);
    return 0;
  }

  if (verdict.survivors.length > 0) {
    io.err(
      `test-gates mutation: ${verdict.survivors.length} surviving mutant(s) not in the allow list`
    );
    for (const survivor of verdict.survivors) {
      io.err(`  - ${formatSurvivor(survivor)}`);
    }
    io.err('');
    io.err(
      'Fix the test so that it detects the mutant. Only when the mutant cannot be observed from'
    );
    io.err('outside (same return value, exception and side effects for every input), add it to');
    io.err('"equivalentMutants" of the gate in test-gates.json and fill in "reason":');
    const byFile = new Map<string, typeof verdict.survivors>();
    for (const survivor of verdict.survivors) {
      byFile.set(survivor.file, [...(byFile.get(survivor.file) ?? []), survivor]);
    }
    for (const [file, survivors] of byFile) {
      io.err('');
      io.err(`  ${file}`);
      survivors.forEach((survivor, index) => {
        const comma = index === survivors.length - 1 ? '' : ',';
        io.err(`    ${JSON.stringify(survivor.allowance)}${comma}`);
      });
    }
    io.err('');
  }
  if (verdict.violations.length > 0) {
    printViolations(io, 'mutation', verdict.violations);
  }
  io.err(`test-gates mutation: FAILED (${summary})`);
  return 1;
}
