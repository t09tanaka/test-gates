import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { UsageError } from '../core/args.js';
import { ManifestError } from '../core/manifest.js';
import { AffectedError, affectedInputs, runnerConfigs } from '../affected-files.js';
import { type AffectedPlan, describePlan, planAffected, timeoutRanges } from '../core/affected.js';
import type { MutationReport, MutationVerdict } from '../core/mutation-result.js';
import {
  type AffectedRecord,
  comparableArgs,
  type GuardRecord,
  incrementalOptions,
  readRecord,
  RECORD_FORMAT,
  refuseReuse,
  type Snapshot,
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
    'jestConfig: config.jest?.configFile,' +
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
    // The report names its files without a leading `./`, which test-gates.json may have.
    const key = gate.replace(/^(?:\.\/)+/, '');
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

/**
 * Decides whether this run may reuse the results of the last one (see core/reuse-guard.ts, and
 * core/affected.ts for `--affected`).
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
  const loaded = loadStrykerConfig(manifest, config);
  const options = incrementalOptions(loaded, strykerArgs);
  if (loaded !== undefined && !options.incremental) {
    // Stryker neither reads nor writes an incremental file
    return affected
      ? {
          ...nothing,
          said: [
            'test-gates mutation --affected: Stryker does not run in incremental mode, so every mutant is run',
          ],
        }
      : nothing;
  }
  // The real path: the files of the snapshot are listed by theirs.
  const base = fs.realpathSync(manifest.dir);
  const incrementalFile = path.resolve(base, options.incrementalFile);
  const recordFile = guardRecordPath(incrementalFile);

  let snapshot: Snapshot | null = null;
  let root = base;
  let failure = 'the Stryker config could not be loaded to see where the incremental file is';
  if (loaded !== undefined) {
    try {
      ({ snapshot, root } = snapshotOf({
        dir: manifest.dir,
        written: [
          incrementalFile,
          recordFile,
          path.resolve(base, options.tempDirName),
          path.resolve(base, manifest.settings.strykerReportFile),
        ],
        args: comparableArgs(strykerArgs),
      }));
    } catch (error) {
      failure = `the files the run depends on could not be listed (${(error as Error).message})`;
    }
  }

  const incremental = hashFile(incrementalFile);
  if (part) {
    // Stryker would take over the old results of the named gates, which the change that is
    // being worked on may have made wrong.
    fs.rmSync(recordFile, { force: true });
    return {
      ...nothing,
      force:
        incremental !== null && !options.force
          ? 'with --gate nothing is taken over from an earlier run'
          : null,
    };
  }
  let stored: unknown;
  try {
    stored = JSON.parse(fs.readFileSync(recordFile, 'utf8')) as unknown;
  } catch {
    stored = undefined;
  }
  const ci = affected ? affectedRefused(process.env) : null;
  const configs = (): ReturnType<typeof runnerConfigs> =>
    runnerConfigs(base, config, (loaded ?? {}) as Record<string, unknown>);

  let force: string | null = null;
  let plan: AffectedPlan | null = null;
  let last: AffectedRecord | undefined;
  if (incremental !== null && !options.force) {
    if (snapshot === null) {
      force = failure;
    } else if (!affected) {
      force = refuseReuse({ record: stored, incremental, snapshot });
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
            })),
          });
        } catch (error) {
          if (!(error instanceof AffectedError)) {
            throw error;
          }
          plan = { full: `what a gate depends on cannot be told: ${error.message}` };
        }
        if ('full' in plan) {
          force = plan.full;
        }
      }
    }
  } else if (affected && incremental === null && !options.force) {
    force = 'there is no incremental file of an earlier run';
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
  // Results that are taken over: never those of a mutant that timed out (see timeoutRanges).
  let ranges: string[] = [];
  if (everyGate === null && incremental !== null && !options.force) {
    const kept =
      rerun === null
        ? manifest.gates.map((gate) => gate.path)
        : manifest.gates.map((gate) => gate.path).filter((gate) => !rerun.includes(gate));
    try {
      ranges = timeoutRanges(
        JSON.parse(fs.readFileSync(incrementalFile, 'utf8')) as Parameters<typeof timeoutRanges>[0],
        kept
      );
    } catch {
      ranges = [];
    }
  }
  const subset = rerun !== null && rerun.length > 0 && everyGate === null ? rerun : [];
  let said: string[] = [];
  if (affected && !options.force) {
    if (force !== null) {
      said = describePlan({ full: force });
    } else if (plan !== null) {
      said = describePlan(plan, 5, ranges.length);
    }
  } else if (ranges.length > 0) {
    said = [
      `test-gates mutation: ${ranges.length} mutant(s) that timed out in the last run are run again, the other results are reused`,
    ];
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
      if (affected && ci === null && judged !== null) {
        record.affected = affectedRecord(judged, rerun, last);
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
          recorded[gate] = { specs: entry.specs, files: entry.files };
        }
      }
      return { tests: Object.keys(judged.report.testFiles ?? {}).sort(), gates: recorded };
    } catch (error) {
      if (error instanceof AffectedError) {
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
