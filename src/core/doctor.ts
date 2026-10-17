/**
 * What `test-gates doctor` tells about a subproject: why a mutation run would not reuse the
 * results of the last one, and what to change so that it can. The facts are gathered by
 * commands/doctor.ts; this module only judges them.
 */
import { listed } from './reuse-guard.js';

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
  /** The Stryker config, or its arguments, give --force. */
  forced: boolean;
  /** Why the files the run depends on could not be listed, or null. */
  failure: string | null;
  /** The files and paths that made every file of the repository part of the comparison. */
  widened: string[];
  /** The files whose paths are followed, or why every file of the subproject is. */
  scope: { files: number } | { every: string } | null;
  /** Hooks that run a mutation run of this subproject. */
  hooks: HookUse[];
  /** Why --affected cannot tell the gates apart at all, or null. */
  blind: string | null;
  /** The gates --affected runs again after a change of any file, with why (see core/affected.ts). */
  blindGates: Array<{ gate: string; reason: string }>;
  /** How many gates test-gates.json lists. */
  gates: number;
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
  if (facts.forced) {
    findings.push({
      level: 'problem',
      text: 'the Stryker config sets force: every run is one of every mutant',
      fix: 'remove force from the Stryker config; pass -- --force where a full run is meant (CI)',
    });
  }
  if (facts.failure !== null) {
    findings.push({
      level: 'problem',
      text: `the results of a run are never reused: ${facts.failure}`,
      fix: facts.failure.includes('points outside')
        ? 'remove the path, or let it lead into the repository. A path that leads outside of it to nothing is compared as missing'
        : null,
    });
  }
  if (facts.widened.length > 0) {
    findings.push({
      level: 'problem',
      text: `every file of the repository is compared, so a change anywhere in it makes the next run a full one. Because of: ${facts.widened.join('; ')}`,
      fix: 'write such a path from the directory of its file (path.resolve(__dirname, …)) so that it can be followed, or keep it out of the files the run loads',
    });
  }
  const everyBlind = facts.blindGates.length >= facts.gates;
  if (facts.blind !== null) {
    // A problem where a hook relies on --affected; else only worth knowing.
    findings.push({
      level: facts.hooks.some((hook) => hook.affected) ? 'problem' : 'note',
      text: `with --affected, a change of any file runs every mutant: what a gate depends on cannot be told (${facts.blind})`,
      fix: 'keep what reads files or loads modules by a computed name out of what the gates and their specs import, or run without --affected',
    });
  } else if (facts.blindGates.length > 0) {
    // The other gates are still told apart: only worth knowing, unless there are none and a hook
    // relies on --affected.
    const gates = facts.blindGates.map((one) => one.gate);
    const reasons = [...new Set(facts.blindGates.map((one) => one.reason))];
    const more = reasons.length > 1 ? ` (and ${reasons.length - 1} more reason(s))` : '';
    findings.push({
      level: everyBlind && facts.hooks.some((hook) => hook.affected) ? 'problem' : 'note',
      text: `with --affected, a change of any file runs ${gates.length} of ${facts.gates} gate(s) again (${listed(gates)}): what they depend on cannot be told (${reasons[0] as string}${more})`,
      fix: 'keep what reads files by a path no import names out of what those gates and their specs import',
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
  // --affected does not help where it cannot tell the gates apart. Where only some gates are
  // blind, it still tells the others apart.
  const toldApart = facts.blind === null && !everyBlind;
  for (const hook of facts.hooks.filter((one) => !one.affected && toldApart)) {
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

/** A run of `test-gates mutation`, also through the npm script, but not of `mutation-result`. */
const RUNS_MUTATION =
  /(?<![\w-])test-gates(?:\.js)?\s+mutation(?![\w-])|(?<![\w:-])test:gates:mutation(?![\w:-])/;
const TARGET = /(?:--dir|--prefix|--workspace|-w)(?:=|\s+)(['"]?)([^\s'";&|)]+)\1/;
const CD = /\bcd\s+(['"]?)([^\s'";&|)]+)\1/;

/**
 * The runs of `test-gates mutation` in the text of a hook that may be ones of `subproject`, and
 * whether each is given `--affected`.
 *
 * A run is taken to be one of the subproject that the same line names (`--dir`, `--prefix`,
 * `-w`, `cd`), else the nearest `cd` on a line before it. A name with a variable in it
 * (`cd "$project"`), or none, may be any subproject. Comments (`#` at the start or after a space)
 * are left out.
 *
 * @param subproject The subproject, relative to the top of the repository; `''` for the top.
 * @param script The `test:gates:mutation` script of the subproject: a run through it is given
 *   `--affected` when the script is.
 */
export function hookUses(input: {
  file: string;
  text: string;
  subproject: string;
  script: string;
}): HookUse[] {
  const lines = input.text.split('\n').map((line) => line.replace(/(?:^|\s)#.*/, ''));
  const uses: HookUse[] = [];
  lines.forEach((line, index) => {
    if (!RUNS_MUTATION.test(line)) {
      return;
    }
    const named = TARGET.exec(line) ?? CD.exec(line);
    const target =
      named?.[2] ??
      lines
        .slice(0, index)
        .reverse()
        .map((before) => CD.exec(before)?.[2])
        .find((found) => found !== undefined);
    const normalized = target
      ?.split('/')
      .filter((part) => part !== '.' && part !== '')
      .join('/');
    const ours =
      normalized === undefined ||
      normalized.includes('$') ||
      normalized.includes('..') ||
      normalized === input.subproject;
    if (ours) {
      uses.push({
        file: input.file,
        affected:
          /--affected\b/.test(line) ||
          (/test:gates:mutation\b/.test(line) && input.script.includes('--affected')),
      });
    }
  });
  return uses;
}
