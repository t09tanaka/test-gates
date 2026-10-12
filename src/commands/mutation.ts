import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { UsageError } from '../core/args.js';
import { ManifestError } from '../core/manifest.js';
import {
  comparableArgs,
  type GuardRecord,
  incrementalOptions,
  RECORD_FORMAT,
  refuseReuse,
  type Snapshot,
} from '../core/reuse-guard.js';
import { gateRunRefused, selectControls } from '../core/selfcheck.js';
import { findLocalBin } from '../fs.js';
import { type LoadedManifest, readManifest } from '../load.js';
import { hashFile, takeSnapshot } from '../snapshot.js';
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

/**
 * Decides whether this run may reuse the results of the last one (see core/reuse-guard.ts).
 *
 * @param part Whether the run is one of `--gate`. Such a run takes nothing over and leaves no
 *   record, so that the next run without `--gate` is one of every mutant.
 * @returns `force`: the reason why every mutant has to be run again, or null. `record`: writes
 *   the record of this run; to be called only after Stryker finished it.
 */
function guardIncremental(
  manifest: LoadedManifest,
  config: string,
  strykerArgs: string[],
  part: boolean
): { force: string | null; record: () => void } {
  const nothing = { force: null, record: () => undefined };
  const loaded = loadStrykerConfig(manifest, config);
  const options = incrementalOptions(loaded, strykerArgs);
  if (loaded !== undefined && !options.incremental) {
    return nothing; // Stryker neither reads nor writes an incremental file
  }
  // The real path: the files of the snapshot are listed by theirs.
  const base = fs.realpathSync(manifest.dir);
  const incrementalFile = path.resolve(base, options.incrementalFile);
  const recordFile = guardRecordPath(incrementalFile);

  let snapshot: Snapshot | null = null;
  let failure = 'the Stryker config could not be loaded to see where the incremental file is';
  if (loaded !== undefined) {
    try {
      snapshot = takeSnapshot({
        dir: manifest.dir,
        written: [
          incrementalFile,
          recordFile,
          path.resolve(base, options.tempDirName),
          path.resolve(base, manifest.settings.strykerReportFile),
        ],
        args: comparableArgs(strykerArgs),
      });
    } catch (error) {
      failure = `the files the run depends on could not be listed (${(error as Error).message})`;
    }
  }

  let force: string | null = null;
  const incremental = hashFile(incrementalFile);
  if (part) {
    // Stryker would take over the old results of the named gates, which the change that is
    // being worked on may have made wrong.
    fs.rmSync(recordFile, { force: true });
    return {
      force:
        incremental !== null && !options.force
          ? 'with --gate nothing is taken over from an earlier run'
          : null,
      record: () => undefined,
    };
  }
  if (incremental !== null && !options.force) {
    if (snapshot === null) {
      force = failure;
    } else {
      let record: unknown;
      try {
        record = JSON.parse(fs.readFileSync(recordFile, 'utf8')) as unknown;
      } catch {
        record = undefined;
      }
      force = refuseReuse({ record, incremental, snapshot });
    }
  }
  // A run that is interrupted or fails must not leave a record that says "nothing changed".
  fs.rmSync(recordFile, { force: true });
  const before = modifiedAt(incrementalFile);

  return {
    force,
    record: () => {
      // Only for an incremental file this run wrote. Stryker can end without writing one
      // (a dry run, no tests): what is on disk then still belongs to an earlier state.
      const written = hashFile(incrementalFile);
      if (snapshot === null || written === null || modifiedAt(incrementalFile) === before) {
        return;
      }
      const record: GuardRecord = { format: RECORD_FORMAT, incremental: written, snapshot };
      try {
        fs.writeFileSync(recordFile, `${JSON.stringify(record)}\n`);
      } catch {
        // without a record the next run is a full one
      }
    },
  };
}

/**
 * Runs the project's own Stryker, then judges its JSON report.
 * `strykerArgs` go to Stryker only; they never reach the judge.
 */
export function runMutation(
  dir: string,
  strykerArgs: string[],
  io: Io,
  only: string[] = []
): number {
  const part = only.length > 0;
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

  const guard = guardIncremental(manifest, config, strykerArgs, part);
  if (guard.force !== null) {
    io.out(
      `test-gates mutation: running every mutant again (--force), the results of the last run are not reused: ${guard.force}`
    );
  }
  const guardArgs = guard.force === null ? [] : ['--force'];
  const partArgs = part ? ['--mutate', chosen.selected.join(',')] : [];

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
  guard.record();
  const status = runMutationResult(dir, null, io, part ? chosen.selected : []);
  if (part) {
    // Not for `mutation-result`: it would judge every gate from this report, the others by
    // results of an earlier run.
    fs.rmSync(reportFile, { force: true });
  }
  return status;
}
