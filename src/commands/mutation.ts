import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { UsageError } from '../core/args.js';
import { ManifestError } from '../core/manifest.js';
import { AffectedError, affectedInputs, loadedScope, runnerConfigs } from '../affected-files.js';
import {
  type AffectedPlan,
  describeExpected,
  describePlan,
  planAffected,
  timeoutRanges,
  withoutDots,
} from '../core/affected.js';
import {
  formatRetry,
  mergeRetry,
  type MutationReport,
  type MutationVerdict,
} from '../core/mutation-result.js';
import {
  type AffectedRecord,
  comparableArgs,
  type GuardRecord,
  incrementalOptions,
  readRecord,
  RECORD_FORMAT,
  refuseReuse,
  reportFiles,
  type Snapshot,
  strykerIgnores,
} from '../core/reuse-guard.js';
import { affectedRefused, gateRunRefused, selectControls } from '../core/selfcheck.js';
import { findLocalBin } from '../fs.js';
import { type LoadedManifest, readManifest } from '../load.js';
import { hashFile, snapshotOf } from '../snapshot.js';
import { findStrykerConfig } from './check.js';
import { reportPathOf, runMutationResult } from './mutation-result.js';
import type { Io } from './output.js';

const CONFIG_MARK = '\u0000test-gates-stryker-config\u0000';

/**
 * The Stryker config as Stryker will load it: evaluated in a process of its own, in the
 * subproject, so that a config that looks at the working directory sees the same one.
 * @returns undefined when the config cannot be loaded.
 */
function loadStrykerConfig(manifest: LoadedManifest, config: string): unknown {
  const file = path.resolve(manifest.dir, config);
  if (file.endsWith('.json')) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    } catch {
      return undefined;
    }
  }
  const script =
    `const loaded = await import(${JSON.stringify(pathToFileURL(file).href)});` +
    'const config = loaded.default?.default ?? loaded.default ?? loaded;' +
    `process.stdout.write(${JSON.stringify(CONFIG_MARK)} + JSON.stringify({` +
    'incremental: config.incremental, force: config.force,' +
    'incrementalFile: config.incrementalFile, tempDirName: config.tempDirName,' +
    'testRunner: config.testRunner, vitestConfig: config.vitest?.configFile,' +
    'jestConfig: config.jest?.configFile, checkers: config.checkers,' +
    'htmlReporter: config.htmlReporter, jsonReporter: config.jsonReporter,' +
    'ignorePatterns: config.ignorePatterns,' +
    `}) + ${JSON.stringify(CONFIG_MARK)});`;
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: manifest.dir,
    encoding: 'utf8',
    timeout: 60_000,
  });
  const printed = result.stdout?.split(CONFIG_MARK)[1];
  if (result.status !== 0 || printed === undefined) {
    return undefined;
  }
  return JSON.parse(printed) as unknown;
}

/** When the file was last written, as text; null when there is no such file. */
function modifiedAt(file: string): string | null {
  try {
    const stat = fs.statSync(file, { bigint: true });
    return `${stat.mtimeNs} ${stat.ino}`;
  } catch {
    return null;
  }
}

/** Where the record of a run is kept: next to the incremental file it belongs to. */
export function guardRecordPath(incrementalFile: string): string {
  return `${incrementalFile}.test-gates.json`;
}

/** What the guard decided for this run. */
interface Guard {
  /** Why every mutant has to be run again, or null. */
  force: string | null;
  /** With --affected: the gates to run, when only some of them are. */
  mutate: string[] | null;
  /** Lines to print before Stryker starts. */
  said: string[];
  /**
   * Writes the record of this run; to be called only after Stryker finished it, with the
   * report and its verdict.
   */
  record: (judged: { report: MutationReport; verdict: MutationVerdict } | null) => void;
}

/** The spec files of the tests that covered or killed a mutant of each gate; null for a gate
 * with a test the report does not place in a file. */
function coveringSpecs(report: MutationReport, gates: string[]): Record<string, string[] | null> {
  const fileOf = new Map<string, string>();
  for (const [file, entry] of Object.entries(report.testFiles ?? {})) {
    for (const test of entry.tests ?? []) {
      fileOf.set(test.id, file);
    }
  }
  const covering = Object.create(null) as Record<string, string[] | null>;
  for (const gate of gates) {
    const specs = new Set<string>();
    let placed = true;
    // The report names its files without `./`, which a path in test-gates.json may have.
    const key = withoutDots(gate);
    for (const mutant of report.files?.[key]?.mutants ?? []) {
      for (const id of [...(mutant.coveredBy ?? []), ...(mutant.killedBy ?? [])]) {
        const file = fileOf.get(id);
        if (file === undefined) {
          placed = false;
        } else {
          specs.add(file);
        }
      }
    }
    covering[gate] = placed ? [...specs].sort() : null;
  }
  return covering;
}

/** What is known before a run about reusing the results of the last one. */
export interface ReuseDecision {
  /** Stryker runs in incremental mode: there is something to reuse at all. */
  incremental: boolean;
  /** The incremental file and the record next to it; null without incremental mode. */
  incrementalFile: string | null;
  recordFile: string | null;
  /** Hash of the incremental file, or null when there is none. */
  incrementalHash: string | null;
  /** Whether Stryker is given --force already, by the config or the arguments. */
  forced: boolean;
  snapshot: Snapshot | null;
  /** Why the snapshot could not be taken, or null. */
  failure: string | null;
  root: string;
  /** What made every file of the repository part of the snapshot (see snapshotOf). */
  widened: string[];
  /** The files whose paths are followed, or why every file is. */
  scope: { files: number } | { every: string } | null;
  /** Why every mutant is run again, or null. */
  force: string | null;
  plan: AffectedPlan | null;
  last: AffectedRecord | undefined;
  /** Whether --affected is refused here (CI), and why. */
  ci: string | null;
  /**
   * With --affected: why the gates could not be told apart, when nothing at all changed since the
   * last run, so that every result is reused as without the option.
   */
  unchanged: string | null;
  configs: () => ReturnType<typeof runnerConfigs>;
}

/**
 * Decides whether this run may reuse the results of the last one (see core/reuse-guard.ts, and
 * core/affected.ts for `--affected`). Changes nothing on disk.
 *
 * @param part Whether the run is one of `--gate`. Such a run takes nothing over.
 */
export function decideReuse(
  manifest: LoadedManifest,
  config: string,
  strykerArgs: string[],
  part: boolean,
  affected: boolean
): ReuseDecision {
  const loaded = loadStrykerConfig(manifest, config);
  const options = incrementalOptions(loaded, strykerArgs);
  // The real path: the files of the snapshot are listed by theirs.
  const base = fs.realpathSync(manifest.dir);
  // Checkers given to Stryker as an argument check types as those of its config do.
  const checkersArg = strykerArgs.some(
    (arg) => arg === '--checkers' || arg.startsWith('--checkers=')
  );
  const configs = (): ReturnType<typeof runnerConfigs> =>
    runnerConfigs(base, config, {
      ...((loaded ?? {}) as Record<string, unknown>),
      ...(checkersArg ? { checkers: ['--checkers'] } : {}),
    });
  const decision: ReuseDecision = {
    incremental: false,
    incrementalFile: null,
    recordFile: null,
    incrementalHash: null,
    forced: options.force,
    snapshot: null,
    failure: null,
    root: base,
    widened: [],
    scope: null,
    force: null,
    plan: null,
    last: undefined,
    ci: affected ? affectedRefused(process.env) : null,
    unchanged: null,
    configs,
  };
  if (loaded !== undefined && !options.incremental) {
    // Stryker neither reads nor writes an incremental file
    return decision;
  }
  decision.incremental = true;
  const incrementalFile = path.resolve(base, options.incrementalFile);
  const recordFile = guardRecordPath(incrementalFile);
  decision.incrementalFile = incrementalFile;
  decision.recordFile = recordFile;

  let snapshot: Snapshot | null = null;
  let root = base;
  let failure = 'the Stryker config could not be loaded to see where the incremental file is';
  // The reports of the run, and what Stryker leaves out of it (a cache of lint, of tsc): a text
  // of the Stryker config that names one is not a file the run reads.
  const reports = reportFiles(loaded).map((file) => path.resolve(base, file));
  const ignores = strykerIgnores(loaded);
  const read = (file: string): boolean => {
    const relative = path.relative(base, file);
    const inside = !relative.startsWith('..') && !path.isAbsolute(relative);
    return !reports.includes(file) && !(inside && ignores(relative.split(path.sep).join('/')));
  };
  if (loaded !== undefined) {
    const scope = (listed: string[]): Set<string> | null => {
      try {
        const found = loadedScope(manifest, configs(), listed);
        if (!('files' in found)) {
          decision.scope = found;
          return null;
        }
        const files = new Set([...found.files].filter(read));
        decision.scope = { files: files.size };
        return files;
      } catch (error) {
        // what the run loads cannot be told: every path is followed
        decision.scope = { every: (error as Error).message };
        return null;
      }
    };
    try {
      let widened: string[];
      ({ snapshot, root, widened } = snapshotOf({
        scope,
        dir: manifest.dir,
        written: [
          incrementalFile,
          recordFile,
          path.resolve(base, options.tempDirName),
          path.resolve(base, manifest.settings.strykerReportFile),
          ...reports,
        ],
        args: comparableArgs(strykerArgs),
      }));
      decision.widened = widened;
    } catch (error) {
      failure = `the files the run depends on could not be listed (${(error as Error).message})`;
    }
  }
  decision.snapshot = snapshot;
  decision.failure = snapshot === null ? failure : null;
  decision.root = root;

  const incremental = hashFile(incrementalFile);
  decision.incrementalHash = incremental;
  if (part) {
    // Stryker would take over the old results of the named gates, which the change that is
    // being worked on may have made wrong.
    decision.force =
      incremental !== null && !options.force
        ? 'with --gate nothing is taken over from an earlier run'
        : null;
    return decision;
  }
  let stored: unknown;
  try {
    stored = JSON.parse(fs.readFileSync(recordFile, 'utf8')) as unknown;
  } catch {
    stored = undefined;
  }
  const ci = decision.ci;

  let force: string | null = null;
  let plan: AffectedPlan | null = null;
  let last: AffectedRecord | undefined;
  if (incremental !== null && !options.force) {
    if (snapshot === null) {
      force = failure;
    } else if (!affected) {
      force = refuseReuse({ record: stored, incremental, snapshot });
      if (force === null) {
        // Every result is taken over: what the last run wrote down about each gate still holds.
        const read = readRecord({ record: stored, incremental, snapshot });
        last = 'record' in read ? read.record.affected : undefined;
      }
    } else if (ci !== null) {
      force = ci;
    } else {
      const read = readRecord({ record: stored, incremental, snapshot });
      if ('refused' in read) {
        force = read.refused;
      } else {
        last = read.record.affected;
        try {
          const inputs = affectedInputs(manifest, {
            root,
            files: snapshot.files,
            configs: configs(),
            tests: last?.tests ?? [],
            covering: Object.fromEntries(
              Object.entries(last?.gates ?? {}).map(([gate, entry]) => [gate, entry.specs])
            ),
          });
          plan = planAffected({
            before: { files: read.record.snapshot.files, affected: last },
            now: snapshot.files,
            subproject: inputs.subproject,
            config: inputs.config,
            gates: manifest.gates.map((gate) => ({
              path: gate.path,
              files: inputs.gates[gate.path]?.files ?? [],
              blind: inputs.gates[gate.path]?.blind,
            })),
          });
        } catch (error) {
          if (!(error instanceof AffectedError)) {
            throw error;
          }
          plan = { full: `what a gate depends on cannot be told: ${error.message}` };
        }
        if ('full' in plan) {
          // What cannot be told gate by gate may still be told for the run as a whole: when
          // nothing at all changed, every result is reused, as without --affected.
          if (refuseReuse({ record: stored, incremental, snapshot }) === null) {
            decision.unchanged = plan.full;
            plan = null;
          } else {
            force = plan.full;
          }
        }
      }
    }
  } else if (affected && incremental === null && !options.force) {
    force = 'there is no incremental file of an earlier run';
  }
  decision.force = force;
  decision.plan = plan;
  decision.last = last;
  return decision;
}

/**
 * Decides whether this run may reuse the results of the last one (see decideReuse), and removes
 * the record, so that a run that fails leaves none.
 *
 * @param part Whether the run is one of `--gate`. Such a run takes nothing over and leaves no
 *   record, so that the next run without `--gate` is one of every mutant.
 */
function guardIncremental(
  manifest: LoadedManifest,
  config: string,
  strykerArgs: string[],
  part: boolean,
  affected: boolean
): Guard {
  const nothing: Guard = { force: null, mutate: null, said: [], record: () => undefined };
  const decision = decideReuse(manifest, config, strykerArgs, part, affected);
  if (!decision.incremental) {
    return affected
      ? {
          ...nothing,
          said: [
            'test-gates mutation --affected: Stryker does not run in incremental mode, so every mutant is run',
          ],
        }
      : nothing;
  }
  const { snapshot, root, plan, last, configs, force } = decision;
  const incrementalFile = decision.incrementalFile as string;
  const recordFile = decision.recordFile as string;
  const incremental = decision.incrementalHash;
  const options = { force: decision.forced };
  if (part) {
    fs.rmSync(recordFile, { force: true });
    return { ...nothing, force };
  }
  // A run that is interrupted or fails must not leave a record that says "nothing changed".
  fs.rmSync(recordFile, { force: true });
  const before = modifiedAt(incrementalFile);

  const rerun = plan !== null && 'rerun' in plan ? plan.rerun.map((entry) => entry.gate) : null;
  const everyGate =
    force ??
    (rerun !== null && rerun.length > 0 && rerun.length === manifest.gates.length
      ? 'every gate is affected'
      : null);
  // Results that are taken over: never those of a mutant that timed out, unless expectedTimeouts
  // lists it (see timeoutRanges).
  let ranges: string[] = [];
  let timedOut = 0;
  let expected = 0;
  if (everyGate === null && incremental !== null && !options.force) {
    const kept =
      rerun === null ? manifest.gates : manifest.gates.filter((gate) => !rerun.includes(gate.path));
    try {
      ({
        ranges,
        rerun: timedOut,
        expected,
      } = timeoutRanges(
        JSON.parse(fs.readFileSync(incrementalFile, 'utf8')) as MutationReport,
        kept
      ));
    } catch {
      // no incremental file to read: Stryker takes nothing over either
    }
  }
  const subset = rerun !== null && rerun.length > 0 && everyGate === null ? rerun : [];
  // The gates whose mutants all run again (null: every gate). Without --affected that is all
  // of them or none: the others take over their results, and with them what was written down.
  const ran = affected
    ? rerun
    : everyGate !== null || options.force || incremental === null
      ? null
      : [];
  let said: string[] = [];
  if (affected && !options.force) {
    if (force !== null) {
      said = describePlan({ full: force });
    } else if (plan !== null) {
      said = describePlan(plan, 5, timedOut, expected);
    } else if (decision.unchanged !== null) {
      said = [
        `test-gates mutation --affected: nothing changed since the last run, every result is reused (gate by gate, ${decision.unchanged.replace(/^what a gate/, 'what each gate')})`,
        ...(ranges.length > 0
          ? [`  and ${timedOut} mutant(s) that timed out in the last run are run again`]
          : []),
        ...(expected > 0 ? [`  ${describeExpected(expected)}`] : []),
      ];
    }
  } else {
    if (ranges.length > 0) {
      said.push(
        `test-gates mutation: ${timedOut} mutant(s) that timed out in the last run are run again, the other results are reused`
      );
    }
    if (expected > 0) {
      said.push(`test-gates mutation: ${describeExpected(expected)}`);
    }
  }
  return {
    // Every gate is run again: the same as a run of every mutant.
    force: everyGate,
    mutate: subset.length + ranges.length > 0 ? [...subset, ...ranges] : null,
    said,
    record: (judged) => {
      // Only for an incremental file this run wrote. Stryker can end without writing one
      // (a dry run, no tests): what is on disk then still belongs to an earlier state.
      const written = hashFile(incrementalFile);
      if (snapshot === null || written === null || modifiedAt(incrementalFile) === before) {
        return;
      }
      const record: GuardRecord = { format: RECORD_FORMAT, incremental: written, snapshot };
      // Also without --affected (a run by hand with -- --force, for one), so that the next run
      // with it can tell the gates apart. Not in CI: --affected is refused there, and a run with
      // it in CI writes nothing about the gates either.
      if (affectedRefused(process.env) === null && judged !== null) {
        record.affected = affectedRecord(judged, ran, last);
      }
      try {
        fs.writeFileSync(recordFile, `${JSON.stringify(record)}\n`);
      } catch {
        // without a record the next run is a full one
      }
    },
  };

  /**
   * What a later run with --affected needs: for each gate whose results are clean, the specs
   * that covered it and the files its results depend on.
   * @param ran The gates this run ran again; null when it ran every gate.
   */
  function affectedRecord(
    judged: { report: MutationReport; verdict: MutationVerdict },
    ran: string[] | null,
    previous: AffectedRecord | undefined
  ): AffectedRecord | undefined {
    const gates = manifest.gates.map((gate) => gate.path);
    const dirty = new Set(
      [...judged.verdict.survivors, ...judged.verdict.unexpectedTimeouts].map((one) => one.file)
    );
    const fresh = coveringSpecs(judged.report, gates);
    const covering = Object.create(null) as Record<string, string[]>;
    for (const gate of gates) {
      // A gate whose results were taken over keeps what was written down about it: the ids of
      // the tests in its results belong to the run that wrote them.
      const specs =
        ran === null || ran.includes(gate) ? fresh[gate] : (previous?.gates[gate]?.specs ?? null);
      if (specs !== null && specs !== undefined && !dirty.has(gate)) {
        covering[gate] = specs;
      }
    }
    try {
      const inputs = affectedInputs(manifest, {
        root,
        files: (snapshot as Snapshot).files,
        configs: configs(),
        tests: Object.keys(judged.report.testFiles ?? {}),
        covering,
      });
      const recorded = Object.create(null) as AffectedRecord['gates'];
      for (const gate of Object.keys(covering)) {
        const entry = inputs.gates[gate];
        if (entry !== undefined) {
          // A blind gate is written down too: the next run reuses it when nothing changed.
          recorded[gate] = {
            specs: entry.specs,
            files: entry.files,
            ...(entry.blind === undefined ? {} : { blind: entry.blind }),
          };
        }
      }
      return { tests: Object.keys(judged.report.testFiles ?? {}).sort(), gates: recorded };
    } catch (error) {
      // Without --affected the run did not ask for this part: whatever keeps it from being
      // worked out leaves it out, and the next run with --affected runs every mutant.
      if (error instanceof AffectedError || !affected) {
        return undefined;
      }
      throw error;
    }
  }
}

/**
 * Runs the project's own Stryker, then judges its JSON report.
 * `strykerArgs` go to Stryker only; they never reach the judge.
 */
export function runMutation(
  dir: string,
  strykerArgs: string[],
  io: Io,
  only: string[] = [],
  affected = false
): number {
  const part = only.length > 0;
  if (affected && strykerArgs.some((arg) => /^(?:--mutate|-m)(?:=|$)/.test(arg))) {
    throw new UsageError(
      '--affected and --mutate cannot be combined: --affected sets --mutate itself'
    );
  }
  if (part) {
    const refused = gateRunRefused(process.env);
    if (refused !== null) {
      throw new UsageError(refused);
    }
    if (strykerArgs.some((arg) => /^(?:--mutate|-m)(?:=|$)/.test(arg))) {
      throw new UsageError('--gate and --mutate cannot be combined: --gate sets --mutate itself');
    }
  }
  const manifest = readManifest(dir);
  const chosen = selectControls({
    gates: manifest.gates.map((gate) => gate.path),
    mode: 'all',
    only,
    shard: null,
  });
  if ('error' in chosen) {
    throw new UsageError(chosen.error);
  }
  const config = findStrykerConfig(manifest);
  if (config === null) {
    throw new ManifestError(
      'no Stryker config found (stryker.gates.config.mjs). Create one, or set settings.stryker.configFile'
    );
  }
  const stryker = findLocalBin(manifest.dir, 'stryker');
  if (stryker === null) {
    throw new ManifestError(
      'stryker is not installed in this project (node_modules/.bin/stryker). Add @stryker-mutator/core as a devDependency'
    );
  }

  // A report left over from an earlier run must not be judged if this run writes none.
  const reportFile = reportPathOf(manifest, null);
  fs.rmSync(reportFile, { force: true });

  const guard = guardIncremental(manifest, config, strykerArgs, part, affected);
  if (guard.said.length > 0) {
    guard.said.forEach((line) => io.out(line));
  } else if (guard.force !== null) {
    io.out(
      `test-gates mutation: running every mutant again (--force), the results of the last run are not reused: ${guard.force}`
    );
  }
  // Only some gates are run again: their mutants with --force, and Stryker takes the results of
  // the others over from its incremental file.
  const guardArgs = guard.force === null && guard.mutate === null ? [] : ['--force'];
  const partArgs = part
    ? ['--mutate', chosen.selected.join(',')]
    : guard.mutate !== null
      ? ['--mutate', guard.mutate.join(',')]
      : [];

  const result = spawnSync(stryker, ['run', config, ...strykerArgs, ...partArgs, ...guardArgs], {
    cwd: manifest.dir,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.error) {
    io.err(`test-gates mutation: cannot start Stryker (${result.error.message})`);
    return 1;
  }
  if (result.status !== 0) {
    io.err(
      `test-gates mutation: Stryker failed (${result.signal ? `signal ${result.signal}` : `exit ${result.status}`}). The result was not judged`
    );
    return 1;
  }
  retryTimeouts(
    stryker,
    [config, ...strykerArgs],
    manifest,
    reportFile,
    part ? manifest.gates.filter((gate) => chosen.selected.includes(gate.path)) : manifest.gates,
    io
  );
  let judged: Parameters<Guard['record']>[0] = null;
  const status = runMutationResult(dir, null, io, part ? chosen.selected : [], (seen) => {
    judged = seen;
  });
  guard.record(judged);
  if (part) {
    // Not for `mutation-result`: it would judge every gate from this report, the others by
    // results of an earlier run.
    fs.rmSync(reportFile, { force: true });
  }
  return status;
}

/**
 * Runs the mutants that timed out outside `expectedTimeouts` once more, one at a time, and puts
 * their new results into the report before it is judged (see mergeRetry).
 *
 * On a loaded machine a mutant that a test kills in a second can time out; with nothing else
 * running next to it, it is killed, or it survives and is judged as a survivor. Only one run
 * again: a mutant that times out in it as well fails as before. Also in CI: a runner with two
 * cores times out under its own load too, and one more run only costs the time of the mutants
 * that timed out.
 *
 * In incremental mode the run again also writes the incremental file, with the new results, so
 * that the next run does not take an old timeout over.
 */
function retryTimeouts(
  stryker: string,
  args: string[],
  manifest: LoadedManifest,
  reportFile: string,
  gates: LoadedManifest['gates'],
  io: Io
): void {
  let first: MutationReport;
  try {
    first = JSON.parse(fs.readFileSync(reportFile, 'utf8')) as MutationReport;
  } catch {
    return; // judged (and refused) by runMutationResult
  }
  if (typeof first !== 'object' || first === null) {
    return;
  }
  const { ranges, rerun } = timeoutRanges(first, gates);
  if (ranges.length === 0) {
    return;
  }
  io.out(
    `test-gates mutation: ${rerun} mutant(s) timed out outside expectedTimeouts, running them again one at a time (--concurrency 1)`
  );
  // The first report must not be taken for one of the run again if that writes none.
  fs.rmSync(reportFile, { force: true });
  const result = spawnSync(
    stryker,
    ['run', ...args, '--mutate', ranges.join(','), '--concurrency', '1', '--force'],
    { cwd: manifest.dir, stdio: 'inherit', shell: process.platform === 'win32' }
  );
  let retry: MutationReport | null = null;
  if (!result.error && result.status === 0) {
    try {
      retry = JSON.parse(fs.readFileSync(reportFile, 'utf8')) as MutationReport;
    } catch {
      retry = null;
    }
  }
  if (retry === null || typeof retry !== 'object') {
    const why = result.error
      ? result.error.message
      : result.signal
        ? `signal ${result.signal}`
        : result.status === 0
          ? 'no report'
          : `exit ${result.status}`;
    io.err(
      `test-gates mutation: running the timed-out mutants again failed (${why}). The first run is judged`
    );
    fs.writeFileSync(reportFile, JSON.stringify(first));
    return;
  }
  const merged = mergeRetry(first, retry, gates);
  fs.writeFileSync(reportFile, JSON.stringify(merged.report));
  io.out(formatRetry(merged.outcome));
}
