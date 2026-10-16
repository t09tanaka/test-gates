/**
 * What `test-gates doctor` tells about a subproject: why a mutation run would not reuse the
 * results of the last one, and what to change so that it can. The facts are gathered by
 * commands/doctor.ts; this module only judges them.
 */

/** A git hook (or a hook manager's config) that runs `test-gates mutation`. */
export interface HookUse {
  /** The file, as it is shown. */
  file: string;
  /** Whether the run it starts is given `--affected`. */
  affected: boolean;
}

export interface DoctorFacts {
  /** Stryker runs in incremental mode. */
  incremental: boolean;
  /** Why the files the run depends on could not be listed, or null. */
  failure: string | null;
  /** The files and paths that made every file of the repository part of the comparison. */
  widened: string[];
  /** The files whose paths are followed, or why every file of the subproject is. */
  scope: { files: number } | { every: string } | null;
  /** Hooks that run a mutation run of this subproject. */
  hooks: HookUse[];
}

export interface Finding {
  /** A problem makes runs full ones that need not be; a note is worth knowing. */
  level: 'problem' | 'note';
  text: string;
  /** What to change, when something can be. */
  fix: string | null;
}

/** The start of the reason loadedScope gives when the runner config is not one of the helpers. */
const NOT_THE_HELPER = 'the runner config is not made with';

export function diagnose(facts: DoctorFacts): Finding[] {
  const findings: Finding[] = [];
  if (!facts.incremental) {
    findings.push({
      level: 'problem',
      text: 'Stryker does not run in incremental mode: every run is one of every mutant',
      fix: 'make the Stryker config with createStrykerGatesConfig, or set incremental: true',
    });
    return findings;
  }
  if (facts.failure !== null) {
    findings.push({
      level: 'problem',
      text: `the results of a run are never reused: ${facts.failure}`,
      fix: 'remove the path, or let it lead into the repository. A path that leads outside of it to nothing is compared as missing',
    });
  }
  if (facts.widened.length > 0) {
    findings.push({
      level: 'problem',
      text: `every file of the repository is compared, so a change anywhere in it makes the next run a full one. Because of: ${facts.widened.join('; ')}`,
      fix: 'write such a path from the directory of its file (path.resolve(__dirname, …)) so that it can be followed, or keep it out of the files the run loads',
    });
  }
  if (facts.scope !== null && 'every' in facts.scope) {
    findings.push({
      level: 'note',
      text: `the paths in every file of the subproject are followed, also in files the run does not load: ${facts.scope.every}`,
      fix: facts.scope.every.startsWith(NOT_THE_HELPER)
        ? 'make the runner config with createJestGatesConfig or createVitestGatesConfig'
        : null,
    });
  }
  if (facts.hooks.length === 0) {
    findings.push({
      level: 'note',
      text: 'no git hook runs test-gates mutation for this subproject',
      fix: null,
    });
  }
  for (const hook of facts.hooks.filter((one) => !one.affected)) {
    findings.push({
      level: 'problem',
      text: `${hook.file} runs test-gates mutation without --affected: a change of any file of the subproject runs every mutant`,
      fix: 'pass --affected in the hook (npm run test:gates:mutation -- --affected); keep the run in CI without it',
    });
  }
  return findings;
}

/** The lines of the report, and the exit code: 1 when there is a problem. */
export function formatFindings(findings: Finding[]): { lines: string[]; status: number } {
  const lines: string[] = [];
  for (const finding of findings) {
    lines.push(`${finding.level === 'problem' ? 'problem' : 'note'}: ${finding.text}`);
    if (finding.fix !== null) {
      lines.push(`  fix: ${finding.fix}`);
    }
  }
  const problems = findings.filter((finding) => finding.level === 'problem').length;
  lines.push(
    problems === 0
      ? 'test-gates doctor: OK'
      : `test-gates doctor: ${problems} problem(s) that make runs full ones`
  );
  return { lines, status: problems === 0 ? 0 : 1 };
}
