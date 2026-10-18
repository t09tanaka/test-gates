import { isUsableEquivalentMutant, MANIFEST_FILE, validateEquivalentMutants } from './manifest.js';
import type { EquivalentMutant, Gate, Violation } from './types.js';

export interface Position {
  line: number;
  column: number;
}

export interface ReportLocation {
  start: Position;
  end: Position;
}

export interface ReportMutant {
  mutatorName: string;
  replacement?: string;
  status: string;
  location: ReportLocation;
  /** Ids of the tests that ran the mutated code (`coverageAnalysis: perTest`). */
  coveredBy?: string[];
  /** Ids of the tests that failed with the mutant. */
  killedBy?: string[];
}

export interface ReportFile {
  source?: string;
  mutants?: ReportMutant[];
}

/** The part of the mutation-testing-elements JSON report that the verdict depends on. */
export interface MutationReport {
  files?: Record<string, ReportFile>;
  /** The spec files, with the ids of their tests (read by `mutation --affected`). */
  testFiles?: Record<string, { tests?: ReportTest[] }>;
}

/** A test of a spec file in the report. Stryker numbers them anew on every run. */
export interface ReportTest {
  id: string;
  name?: string;
  location?: { start: Position };
}

/** A survivor that no allowance covers. `allowance` can be pasted into `equivalentMutants`. */
export interface UnallowedSurvivor {
  file: string;
  line: number;
  column: number;
  status: string;
  mutator: string;
  original: string;
  replacement: string;
  /** 1-based position among the mutants of the file with the same mutator/original/replacement. */
  occurrence: number;
  /** How many mutants of the file share that key. `occurrence` is required when this is > 1. */
  sameKeyCount: number;
  allowance: EquivalentMutant;
}

export interface MutationSummary {
  total: number;
  /** Killed + Timeout. */
  detected: number;
  /**
   * The Timeout part of `detected`. Shown on its own: under heavy load mutants time out that
   * would otherwise survive, so a high number means the run may be hiding survivors.
   */
  timeout: number;
  /** Survived / NoCoverage mutants matched by an allowance. */
  allowed: number;
  /** RuntimeError + CompileError: the mutated code is not a program, so nothing was evaluated. */
  notEvaluable: number;
  /** Survived / NoCoverage mutants with no allowance. */
  unallowed: number;
  /** The part of `timeout` that `expectedTimeouts` entries cover. */
  expectedTimeout: number;
}

export interface MutationVerdict {
  violations: Violation[];
  survivors: UnallowedSurvivor[];
  /**
   * Timed-out mutants that no `expectedTimeouts` entry covers. When there are more of them
   * than `maxTimeouts`, `violations` says so.
   */
  unexpectedTimeouts: UnallowedSurvivor[];
  summary: MutationSummary;
}

const DETECTED = new Set(['Killed', 'Timeout']);
const SURVIVED = new Set(['Survived', 'NoCoverage']);
const NOT_EVALUABLE = new Set(['RuntimeError', 'CompileError']);

/** Whitespace is not part of the key, so reformatting a gate does not invalidate an allowance. */
export function normalizeCode(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function normalizePath(file: string): string {
  return file.replace(/\\/g, '/').replace(/^\.\//, '');
}

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

/**
 * Cuts the text a report location points at. Lines and columns are 1-based and the end is
 * exclusive. Returns null when the location is outside the source.
 */
export function sliceByLocation(source: string, location: ReportLocation): string | null {
  const lines = source.split('\n');
  const { start, end } = location;
  const first = lines[start.line - 1];
  const last = lines[end.line - 1];
  if (
    first === undefined ||
    last === undefined ||
    start.column < 1 ||
    end.column < 1 ||
    end.line < start.line ||
    (end.line === start.line && end.column < start.column)
  ) {
    return null;
  }
  if (start.line === end.line) {
    return first.slice(start.column - 1, end.column - 1);
  }
  return [
    first.slice(start.column - 1),
    ...lines.slice(start.line, end.line - 1),
    last.slice(0, end.column - 1),
  ].join('\n');
}

function keyOf(mutator: string, original: string, replacement: string): string {
  return JSON.stringify([mutator, normalizeCode(original), normalizeCode(replacement)]);
}

/** A mutant with the source text it replaces, and where it stands among those of its key. */
export interface LocatedMutant {
  mutant: ReportMutant;
  original: string;
  replacement: string;
  occurrence: number;
  sameKeyCount: number;
}

/** The mutants of one file, grouped by mutator + original + replacement. */
export interface LocatedMutants {
  /** In the order of their start in the file. */
  located: LocatedMutant[];
  byKey: Map<string, LocatedMutant[]>;
  /** The mutants whose location is outside the source; they are in neither list. */
  outside: ReportMutant[];
}

/**
 * Cuts the original text of each mutant from the source and numbers the mutants that share a
 * key in the order of their start, as `occurrence` counts them.
 */
export function locateMutants(source: string, mutants: ReportMutant[]): LocatedMutants {
  const located: LocatedMutant[] = [];
  const byKey = new Map<string, LocatedMutant[]>();
  const outside: ReportMutant[] = [];
  const sorted = [...mutants].sort(
    (a, b) =>
      a.location.start.line - b.location.start.line ||
      a.location.start.column - b.location.start.column
  );
  for (const mutant of sorted) {
    const original = sliceByLocation(normalizeNewlines(source), mutant.location);
    if (original === null) {
      outside.push(mutant);
      continue;
    }
    const replacement = mutant.replacement ?? '';
    const key = keyOf(mutant.mutatorName, original, replacement);
    const group = byKey.get(key) ?? [];
    const entry = { mutant, original, replacement, occurrence: group.length + 1, sameKeyCount: 0 };
    group.push(entry);
    byKey.set(key, group);
    located.push(entry);
  }
  for (const group of byKey.values()) {
    for (const entry of group) {
      entry.sameKeyCount = group.length;
    }
  }
  return { located, byKey, outside };
}

/**
 * The mutant an entry of `equivalentMutants` or `expectedTimeouts` points at. Without
 * `occurrence` the entry has to match one mutant only. `target` is undefined when it matches
 * none (a stale entry).
 */
export function resolveEntry(
  entry: EquivalentMutant,
  byKey: Map<string, LocatedMutant[]>
): { target: LocatedMutant | undefined } | { ambiguous: number } {
  const group = byKey.get(keyOf(entry.mutator, entry.original, entry.replacement)) ?? [];
  if (entry.occurrence === undefined && group.length > 1) {
    return { ambiguous: group.length };
  }
  return { target: group[(entry.occurrence ?? 1) - 1] };
}

/**
 * The mutants of a gate that its `expectedTimeouts` entries point at, matched as
 * judgeMutationReport matches them. An entry that matches several mutants without
 * `occurrence`, or none, points at nothing; so does every entry when the source cannot be read
 * or a location is outside it.
 *
 * @param source The source of the gate, or undefined when it cannot be read.
 */
export function expectedTimeoutMutants(
  gate: Pick<Gate, 'expectedTimeouts'>,
  source: string | undefined,
  mutants: ReportMutant[]
): Set<ReportMutant> {
  const pointed = new Set<ReportMutant>();
  if (source === undefined || !Array.isArray(gate.expectedTimeouts)) {
    return pointed;
  }
  const { byKey, outside } = locateMutants(source, mutants);
  if (outside.length > 0) {
    return pointed;
  }
  for (const entry of gate.expectedTimeouts as unknown[]) {
    if (!isUsableEquivalentMutant(entry)) {
      continue;
    }
    const found = resolveEntry(entry, byKey);
    if ('target' in found && found.target !== undefined) {
      pointed.add(found.target.mutant);
    }
  }
  return pointed;
}

/** A mutant as it is listed for the reader, with the entry that would cover it. */
function describeMutant(file: string, entry: LocatedMutant): UnallowedSurvivor {
  const { mutant } = entry;
  return {
    file,
    line: mutant.location.start.line,
    column: mutant.location.start.column,
    status: mutant.status,
    mutator: mutant.mutatorName,
    original: normalizeCode(entry.original),
    replacement: normalizeCode(entry.replacement),
    occurrence: entry.occurrence,
    sameKeyCount: entry.sameKeyCount,
    allowance: {
      mutator: mutant.mutatorName,
      original: normalizeCode(entry.original),
      replacement: normalizeCode(entry.replacement),
      ...(entry.sameKeyCount > 1 ? { occurrence: entry.occurrence } : {}),
      reason: '',
    },
  };
}

function describeAllowance(entry: EquivalentMutant): string {
  const occurrence = entry.occurrence === undefined ? '' : ` / occurrence ${entry.occurrence}`;
  return `${entry.mutator} / ${normalizeCode(entry.original)} → ${normalizeCode(entry.replacement)}${occurrence}`;
}

/**
 * Decides whether a Stryker run passes.
 *
 * Killed and Timeout mutants are detected. Survived and NoCoverage mutants must each be covered
 * by one allowance of the gate (`equivalentMutants`), matched by mutator + original source text
 * + replacement. RuntimeError and CompileError are counted but do not fail. Ignored, Pending
 * and any unknown status fail: a mutant that was not evaluated proves nothing.
 *
 * An allowance fails the run when it matches no surviving mutant (stale), when it matches
 * several mutants and has no `occurrence`, or when two allowances point at the same mutant.
 *
 * @param input.readSource Source of a gate on disk; `undefined` when it cannot be read. Used
 *   when the report carries no source, and to reject a report made from an older file.
 */
export function judgeMutationReport(input: {
  gates: Gate[];
  report: MutationReport;
  readSource: (gatePath: string) => string | undefined;
  /**
   * `settings.mutation.maxTimeouts`: how many timeouts outside `expectedTimeouts` are
   * tolerated. Absent means 0.
   */
  maxTimeouts?: number;
}): MutationVerdict {
  const violations: Violation[] = [];
  const survivors: UnallowedSurvivor[] = [];
  const unexpectedTimeouts: UnallowedSurvivor[] = [];
  const summary: MutationSummary = {
    total: 0,
    detected: 0,
    timeout: 0,
    allowed: 0,
    notEvaluable: 0,
    unallowed: 0,
    expectedTimeout: 0,
  };

  const files = new Map<string, ReportFile>();
  for (const [file, result] of Object.entries(input.report.files ?? {})) {
    files.set(normalizePath(file), result);
  }

  for (const gate of input.gates) {
    const gatePath = normalizePath(gate.path);
    const shapeViolations = validateEquivalentMutants(gate.path, gate.equivalentMutants);
    violations.push(...shapeViolations);
    violations.push(
      ...validateEquivalentMutants(gate.path, gate.expectedTimeouts, 'expectedTimeouts')
    );

    const result = files.get(gatePath);
    if (!result || !Array.isArray(result.mutants) || result.mutants.length === 0) {
      violations.push({
        file: gate.path,
        message: 'no mutants in the report (the gate was not mutation tested)',
      });
      continue;
    }

    const diskSource = input.readSource(gate.path);
    const source = result.source ?? diskSource;
    if (source === undefined) {
      violations.push({
        file: gate.path,
        message: 'source is neither in the report nor readable on disk',
      });
      continue;
    }
    if (
      result.source !== undefined &&
      diskSource !== undefined &&
      normalizeNewlines(result.source) !== normalizeNewlines(diskSource)
    ) {
      violations.push({
        file: gate.path,
        message: 'the report was made from a different version of this file. Run Stryker again',
      });
      continue;
    }

    const { located, byKey, outside } = locateMutants(source, result.mutants);
    for (const mutant of outside) {
      violations.push({
        file: gate.path,
        line: mutant.location.start.line,
        message: `the report location of a ${mutant.mutatorName} mutant is outside the source`,
      });
    }
    if (outside.length > 0) {
      continue;
    }

    // Decide which mutant each entry of a list points at. `accept` returns why the mutant
    // cannot be claimed, or null when it can.
    const claim = (
      field: 'equivalentMutants' | 'expectedTimeouts',
      entries: unknown,
      noun: 'allowance' | 'entry',
      accept: (status: string) => string | null
    ): Set<LocatedMutant> => {
      const claimed = new Set<LocatedMutant>();
      if (!Array.isArray(entries)) {
        return claimed; // not a list: already reported by validateEquivalentMutants
      }
      entries.forEach((entry: unknown, index: number) => {
        if (!isUsableEquivalentMutant(entry)) {
          return; // already reported by validateEquivalentMutants
        }
        const at = `${gate.path}: ${field}[${index}] (${describeAllowance(entry)})`;
        const found = resolveEntry(entry, byKey);
        if ('ambiguous' in found) {
          violations.push({
            file: MANIFEST_FILE,
            message: `${at}: matches ${found.ambiguous} mutants in the file. Add "occurrence" (1-based) to pick one`,
          });
          return;
        }
        const target = found.target;
        const refusal = target
          ? accept(target.mutant.status)
          : `stale ${noun} (no such mutant in this run). Remove it`;
        if (!target || refusal !== null) {
          violations.push({ file: MANIFEST_FILE, message: `${at}: ${refusal}` });
          return;
        }
        if (claimed.has(target)) {
          violations.push({
            file: MANIFEST_FILE,
            message: `${at}: another ${noun} already covers this mutant`,
          });
          return;
        }
        claimed.add(target);
      });
      return claimed;
    };

    const allowed = claim('equivalentMutants', gate.equivalentMutants, 'allowance', (status) =>
      SURVIVED.has(status) ? null : `stale allowance (the mutant is now ${status}). Remove it`
    );
    // An expected timeout that is Killed is accepted: a loop that never ends is reported as
    // Timeout or as Killed depending on which timer fires first, and that depends on load.
    // One that survives is not a timeout at all.
    const expected = claim('expectedTimeouts', gate.expectedTimeouts, 'entry', (status) =>
      SURVIVED.has(status)
        ? `the mutant ${status === 'NoCoverage' ? 'has no coverage' : 'survived'} instead of timing out. Detect it with a test`
        : null
    );

    for (const entry of located) {
      const { mutant } = entry;
      summary.total += 1;
      if (DETECTED.has(mutant.status)) {
        summary.detected += 1;
        if (mutant.status === 'Timeout') {
          summary.timeout += 1;
          if (expected.has(entry)) {
            summary.expectedTimeout += 1;
          } else {
            unexpectedTimeouts.push(describeMutant(gate.path, entry));
          }
        }
      } else if (NOT_EVALUABLE.has(mutant.status)) {
        summary.notEvaluable += 1;
      } else if (SURVIVED.has(mutant.status)) {
        if (allowed.has(entry)) {
          summary.allowed += 1;
          continue;
        }
        summary.unallowed += 1;
        survivors.push(describeMutant(gate.path, entry));
      } else {
        violations.push({
          file: gate.path,
          line: mutant.location.start.line,
          message:
            mutant.status === 'Ignored'
              ? `a ${mutant.mutatorName} mutant was ignored. Taking mutants out with Stryker comments or mutator exclusions is not allowed`
              : `a ${mutant.mutatorName} mutant was not evaluated (status: ${mutant.status})`,
        });
      }
    }
  }

  if (summary.total === 0) {
    violations.push({
      file: MANIFEST_FILE,
      message: 'no mutants were evaluated (the mutation test ran on nothing)',
    });
  }

  const maxTimeouts = input.maxTimeouts ?? 0;
  if (unexpectedTimeouts.length > maxTimeouts) {
    violations.push({
      file: MANIFEST_FILE,
      message: `${unexpectedTimeouts.length} mutant(s) timed out outside expectedTimeouts; settings.mutation.maxTimeouts allows ${maxTimeouts}`,
    });
  }

  return { violations, survivors, unexpectedTimeouts, summary };
}

/** The start of an id of a test that the first run does not have (see mergeRetry). */
export const UNKNOWN_TEST = 'not-in-the-first-run:';

/** What running the timed-out mutants again changed (see mergeRetry). */
export interface RetryOutcome {
  /** How many mutants were run again. */
  retried: number;
  /** Their status in the run again, by status. */
  statuses: Record<string, number>;
  /** How many of them the report of the run again does not hold; they stay `Timeout`. */
  missing: number;
}

/** The same mutant in the report of another run of the same source. */
function sameMutant(a: ReportMutant, b: ReportMutant): boolean {
  return (
    a.mutatorName === b.mutatorName &&
    (a.replacement ?? '') === (b.replacement ?? '') &&
    a.location.start.line === b.location.start.line &&
    a.location.start.column === b.location.start.column &&
    a.location.end.line === b.location.end.line &&
    a.location.end.column === b.location.end.column
  );
}

/**
 * Puts the results of a run again of the timed-out mutants into the report of the first run.
 *
 * The mutants run again are those of the given gates that timed out and that no
 * `expectedTimeouts` entry points at (matched as expectedTimeoutMutants matches them, as
 * timeoutRanges picks them for `--mutate`). Each takes its result from the run again, whatever
 * it is: a mutant that survives there is a survivor, not a timeout. One that the run again does
 * not report stays `Timeout`. Every other mutant keeps its result from the first run.
 *
 * The report keeps the tests of the first run. Stryker numbers the tests anew on every run, so
 * the ids in a mutant taken from the run again are turned into those of the same tests (by file,
 * name and place) in the first run; one that names no test of the first run, or more than one,
 * becomes an id that no test has.
 */
export function mergeRetry(
  first: MutationReport,
  retry: MutationReport,
  gates: Array<Pick<Gate, 'path' | 'expectedTimeouts'>>
): { report: MutationReport; outcome: RetryOutcome } {
  const outcome: RetryOutcome = { retried: 0, statuses: {}, missing: 0 };
  const firstId = translator(first, retry);
  const files = { ...first.files };
  const again = retry.files ?? {};
  for (const named of gates) {
    // Stryker names its files without `./`, which a path in test-gates.json may have.
    const gate = named.path
      .split('/')
      .filter((part) => part !== '.')
      .join('/');
    const result = Object.hasOwn(files, gate) ? files[gate] : undefined;
    if (result?.mutants === undefined) {
      continue;
    }
    const expected = expectedTimeoutMutants(named, result.source, result.mutants);
    const rerun = Object.hasOwn(again, gate) ? again[gate]?.mutants : undefined;
    files[gate] = {
      ...result,
      mutants: result.mutants.map((mutant) => {
        if (mutant.status !== 'Timeout' || expected.has(mutant)) {
          return mutant;
        }
        outcome.retried += 1;
        const found = rerun?.find((other) => sameMutant(other, mutant));
        if (found === undefined) {
          outcome.missing += 1;
          return mutant;
        }
        outcome.statuses[found.status] = (outcome.statuses[found.status] ?? 0) + 1;
        return {
          ...found,
          ...(found.coveredBy === undefined ? {} : { coveredBy: found.coveredBy.map(firstId) }),
          ...(found.killedBy === undefined ? {} : { killedBy: found.killedBy.map(firstId) }),
        };
      }),
    };
  }
  return { report: { ...first, files }, outcome };
}

/** What tells a test apart from the others, the same in every run: its file, name and place. */
function testKey(file: string, test: ReportTest): string {
  const start = test.location?.start;
  return JSON.stringify([file, test.name ?? '', start?.line, start?.column]);
}

/** The tests of a report, each with the key of testKey. */
function* keyedTests(report: MutationReport): Generator<{ id: string; key: string }> {
  for (const [file, entry] of Object.entries(report.testFiles ?? {})) {
    if (entry.tests !== undefined) {
      for (const test of entry.tests) {
        yield { id: test.id, key: testKey(file, test) };
      }
    }
  }
}

/**
 * Turns the ids of the tests in a mutant of the run again into those of the same tests in the
 * first run (see mergeRetry), as Stryker's incremental mode matches tests across runs.
 */
function translator(first: MutationReport, retry: MutationReport): (id: string) => string {
  // null for a key that more than one test of the first run has
  const firstIds = new Map<string, string | null>();
  for (const { id, key } of keyedTests(first)) {
    firstIds.set(key, firstIds.has(key) ? null : id);
  }
  const ids = new Map<string, string | null | undefined>();
  for (const { id, key } of keyedTests(retry)) {
    ids.set(id, firstIds.get(key));
  }
  return (id) => {
    const found = ids.get(id);
    // An id that is not one of the first run: it names no spec file, so that no spec is ever
    // written down for the gate, rather than a wrong one or too few.
    return typeof found === 'string' ? found : `${UNKNOWN_TEST}${id}`;
  };
}

/** One line on what running the timed-out mutants again gave. */
export function formatRetry(outcome: RetryOutcome): string {
  const statuses = Object.entries(outcome.statuses)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([status, count]) => `${count} ${status}`);
  if (outcome.missing > 0) {
    statuses.push(`${outcome.missing} not in the report (still Timeout)`);
  }
  return `test-gates mutation: ${outcome.retried} mutant(s) that timed out were run again one at a time (--concurrency 1): ${statuses.join(', ')}`;
}

/** `file:line:column / mutator / original → replacement / occurrence n of m`. */
export function formatSurvivor(survivor: UnallowedSurvivor): string {
  const occurrence =
    survivor.sameKeyCount > 1
      ? ` / occurrence ${survivor.occurrence} of ${survivor.sameKeyCount}`
      : '';
  return `${survivor.file}:${survivor.line}:${survivor.column} / ${survivor.mutator} / ${survivor.original} → ${survivor.replacement}${occurrence} (${survivor.status})`;
}

/** The real numbers, on one line. Deliberately not a percentage. */
export function formatSummary(summary: MutationSummary): string {
  return (
    `mutants ${summary.total} / detected ${summary.detected} (timeout ${summary.timeout}) / ` +
    `allowed equivalent ${summary.allowed} / not evaluable ${summary.notEvaluable} / ` +
    `unallowed survivors ${summary.unallowed}`
  );
}
