import fs from 'node:fs';
import path from 'node:path';
import {
  formatSummary,
  formatSurvivor,
  judgeMutationReport,
  type MutationReport,
  type MutationVerdict,
} from '../core/mutation-result.js';
import { gateRunCaveat } from '../core/selfcheck.js';
import { readManifest, type LoadedManifest } from '../load.js';
import { type Io, printViolations } from './output.js';

export function reportPathOf(manifest: LoadedManifest, override: string | null): string {
  return path.resolve(manifest.dir, override ?? manifest.settings.strykerReportFile);
}

/**
 * @param only The gates of `mutation --gate`: only they are judged. The report of such a run
 *   can hold old results of the other gates (Stryker takes them over from its incremental
 *   file), which say nothing about the code as it is now.
 * @param retried Whether `mutation` ran the timeouts of this report again one at a time.
 */
export function runMutationResult(
  dir: string,
  reportOverride: string | null,
  io: Io,
  only: string[] = [],
  seen: (judged: { report: MutationReport; verdict: MutationVerdict }) => void = () => undefined,
  retried = false
): number {
  const manifest = readManifest(dir);
  const gates =
    only.length === 0 ? manifest.gates : manifest.gates.filter((gate) => only.includes(gate.path));
  const caveat = only.length === 0 ? '' : gateRunCaveat(gates.length, manifest.gates.length);
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
    gates,
    report,
    maxTimeouts: manifest.settings.maxTimeouts,
    readSource: (gatePath) => {
      try {
        return fs.readFileSync(path.join(manifest.dir, gatePath), 'utf8');
      } catch {
        return undefined;
      }
    },
  });
  seen({ report, verdict });
  const summary = formatSummary(verdict.summary);

  if (verdict.violations.length === 0 && verdict.survivors.length === 0) {
    io.out(`test-gates mutation: OK (${summary})${caveat}`);
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
  const maxTimeouts = manifest.settings.maxTimeouts;
  if (verdict.unexpectedTimeouts.length > maxTimeouts) {
    io.err(
      `test-gates mutation: ${verdict.unexpectedTimeouts.length} mutant(s) timed out (settings.mutation.maxTimeouts: ${maxTimeouts})`
    );
    for (const mutant of verdict.unexpectedTimeouts) {
      io.err(`  - ${formatSurvivor(mutant)}`);
    }
    io.err('');
    if (retried) {
      io.err('They timed out again when they were run one at a time (--concurrency 1), so they');
      io.err('most likely never finish. Look at each mutant first. Only for a');
    } else {
      io.err('A timeout counts as detected, but on a loaded machine a mutant that would survive');
      io.err('can time out instead. `test-gates mutation` runs such timeouts again one at a time');
      io.err('(--concurrency 1) before it fails; these were not run again. Only for a');
    }
    io.err('mutant that can never finish (a loop that no longer ends), add it to');
    io.err('"expectedTimeouts" of the gate in test-gates.json and fill in "reason"');
    io.err('(settings.mutation.maxTimeouts raises the limit for the whole project):');
    for (const mutant of verdict.unexpectedTimeouts) {
      io.err(`    ${mutant.file}: ${JSON.stringify(mutant.allowance)}`);
    }
    io.err('');
  }
  if (verdict.violations.length > 0) {
    printViolations(io, 'mutation', verdict.violations);
  }
  io.err(`test-gates mutation: FAILED (${summary})${caveat}`);
  return 1;
}
