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
  /**
   * The sandboxes earlier Stryker runs left in the temp directory, and why the next mutation run
   * would keep them (null: it removes them), with the pid of a run going on when that is why.
   * Null when there are none.
   */
  sandboxes: {
    tempDir: string;
    count: number;
    kept: string | null;
    running: number | null;
  } | null;
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
  if (facts.sandboxes !== null) {
    const { tempDir, count, kept, running } = facts.sandboxes;
    findings.push(
      running === null
        ? {
            level: 'note',
            text: `${count} sandbox(es) an interrupted Stryker run left in ${tempDir}: a tool that walks the subproject (a test runner, a script) finds a copy of every file in them`,
            fix:
              kept === null
                ? 'the next test-gates mutation removes them'
                : `remove them by hand; the next test-gates mutation keeps them, because ${kept}`,
          }
        : {
            // The sandboxes may be those of that run: removing them would break it.
            level: 'note',
            text: `another test-gates mutation is running in this subproject (pid ${running}): the ${count} sandbox(es) in ${tempDir} are in use`,
            fix: 'leave them; the first test-gates mutation after that run ends removes what is left',
          }
    );
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

/** What a variable holds in a part of a hook: one of the names, or null for any value. */
interface Scope {
  kind: 'case' | 'loop';
  /** The same for every branch of one case, and different for each other case or loop. */
  id: symbol;
  variable: string | null;
  names: string[] | null;
}

/** A line of a hook, or a part of one cut at `;;` and at the pattern of a branch. */
interface Part {
  text: string;
  /** The scopes it lies in, innermost last. The parts of one branch share the same array. */
  scopes: Scope[];
}

const NONE: Scope[] = [];
/** Where a word starts a command. */
const COMMAND = String.raw`(?<=(?:^|[\n;&|(){]|\b(?:then|else|do))\s*)`;
const TOKEN = new RegExp(
  String.raw`\n|;;&?|;&|${COMMAND}(?:case\s+(\S+)\s+in|for\s+(\w+)(?:\s+in\s+([^;\n]*))?|(esac|do|done))(?![\w-])`,
  'g'
);
/** The pattern of a branch, or the `esac` that ends the case instead. */
const PATTERN = /\s*(?:esac(?![\w-])|\(?([^()\n;]*)\))/y;
const VARIABLE = /^("?)\$(?:(\w+)|\{(\w+)\})\1$/;
const REFERENCE = /\$(?:(\w+)|\{(\w+)\})/g;

/** The names a list of words gives, or null when a word may stand for others. */
function namesOf(words: string[]): string[] | null {
  const names = words.map((word) => word.trim().replace(/^(["'])(.*)\1$/, '$2'));
  return names.some((name) => name === '' || /[$*?[{}~\\`"']/.test(name)) ? null : names;
}

/**
 * The parts of a hook, each with what `case "$var" in` and `for var in …` around it tell of a
 * variable. Null where the hook cannot be read so (a fall-through `;&`, a case or a loop that is
 * not closed, a `;;` outside of a case).
 */
function partsOf(text: string): Part[] | null {
  const parts: Part[] = [];
  let scopes = NONE;
  let start = 0;
  let loop: Scope | null = null;
  const enter = (scope: Scope) => {
    scopes = [...scopes, scope];
  };
  const leave = (kind: Scope['kind']): boolean => {
    const left = scopes.at(-1)?.kind === kind;
    scopes = scopes.slice(0, -1);
    return left;
  };
  TOKEN.lastIndex = 0;
  for (;;) {
    const token = TOKEN.exec(text);
    parts.push({ text: text.slice(start, token?.index), scopes });
    if (token === null) {
      return scopes.length === 0 ? parts : null;
    }
    const [word, subject, variable, list, keyword] = token;
    let awaiting = false;
    if (subject !== undefined) {
      const named = VARIABLE.exec(subject);
      enter({
        kind: 'case',
        id: Symbol(),
        variable: named?.[2] ?? named?.[3] ?? null,
        names: null,
      });
      awaiting = true;
    } else if (variable !== undefined) {
      loop = {
        kind: 'loop',
        id: Symbol(),
        variable,
        names: list === undefined ? null : namesOf(list.trim().split(/\s+/)),
      };
    } else if (keyword === 'do') {
      enter(loop ?? { kind: 'loop', id: Symbol(), variable: null, names: null });
      loop = null;
    } else if (keyword === 'done' || keyword === 'esac') {
      if (!leave(keyword === 'done' ? 'loop' : 'case')) {
        return null;
      }
    } else if (word === ';&') {
      return null;
    } else if (word !== '\n') {
      if (scopes.at(-1)?.kind !== 'case') {
        return null;
      }
      awaiting = true;
    }
    start = TOKEN.lastIndex;
    if (awaiting) {
      PATTERN.lastIndex = start;
      const pattern = PATTERN.exec(text);
      if (pattern === null) {
        return null;
      }
      start = PATTERN.lastIndex;
      TOKEN.lastIndex = start;
      const top = scopes.at(-1) as Scope;
      scopes = scopes.slice(0, -1);
      if (pattern[1] !== undefined) {
        enter({ ...top, names: namesOf(pattern[1].split('|')) });
      }
    }
  }
}

/** Whether a part lies in another branch of a case that a part in `scopes` lies in. */
function sibling(of: Scope[], scopes: Scope[]): boolean {
  const apart = of.findIndex((scope, at) => scope !== scopes[at]);
  return apart !== -1 && (of[apart] as Scope).id === scopes[apart]?.id;
}

/** Each path a target can be, with the variables that a scope tells the names of put in. */
function expansions(target: string, scopes: Scope[]): string[] {
  return [...target.matchAll(REFERENCE)].reduce(
    (words, [reference, plain, braced]) => {
      const names = [...scopes].reverse().find((scope) => scope.variable === (plain ?? braced))
        ?.names ?? [reference];
      return words.flatMap((word) => names.map((name) => word.replace(reference, name)));
    },
    [target]
  );
}

/**
 * The runs of `test-gates mutation` in the text of a hook that may be ones of `subproject`, and
 * whether each is given `--affected`.
 *
 * A run is taken to be one of the subproject that the same line names (`--dir`, `--prefix`,
 * `-w`, `cd`), else the nearest `cd` on a line before it. A name with a variable in it
 * (`cd "$project"`), or none, may be any subproject, except in a branch of `case "$project" in`
 * or in `for project in …` that writes the names out: there it is one of those names. A pattern
 * or a word that may stand for others (`*`, `app*`), and a hook that cannot be read so, leave it
 * any. A `cd` in another branch of the same case is not looked at, and the variable of a `cd` on a line before the run is narrowed only in the same branch. Comments (`#` at the
 * start or after a space) are left out.
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
  const parts = partsOf(lines.join('\n')) ?? lines.map((text) => ({ text, scopes: NONE }));
  const uses: HookUse[] = [];
  const cds = parts.map((part) => ({ cd: CD.exec(part.text)?.[2], scopes: part.scopes }));
  parts.forEach((part, index) => {
    if (!RUNS_MUTATION.test(part.text)) {
      return;
    }
    const named = TARGET.exec(part.text) ?? CD.exec(part.text);
    const before = cds
      .slice(0, index)
      .reverse()
      .find((one) => one.cd !== undefined && !sibling(one.scopes, part.scopes));
    const target = named?.[2] ?? before?.cd;
    const scopes = named !== null || before?.scopes === part.scopes ? part.scopes : NONE;
    const ours =
      target === undefined ||
      expansions(target, scopes).some((word) => {
        const normalized = word
          .split('/')
          .filter((one) => one !== '.' && one !== '')
          .join('/');
        return (
          normalized.includes('$') || normalized.includes('..') || normalized === input.subproject
        );
      });
    if (ours) {
      uses.push({
        file: input.file,
        affected:
          /--affected\b/.test(part.text) ||
          (/test:gates:mutation\b/.test(part.text) && input.script.includes('--affected')),
      });
    }
  });
  return uses;
}
