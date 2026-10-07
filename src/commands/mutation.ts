import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { ManifestError } from '../core/manifest.js';
import { findLocalBin } from '../fs.js';
import { readManifest } from '../load.js';
import { findStrykerConfig } from './check.js';
import { reportPathOf, runMutationResult } from './mutation-result.js';
import type { Io } from './output.js';

/**
 * Runs the project's own Stryker, then judges its JSON report.
 * `strykerArgs` go to Stryker only; they never reach the judge.
 */
export function runMutation(dir: string, strykerArgs: string[], io: Io): number {
  const manifest = readManifest(dir);
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
  fs.rmSync(reportPathOf(manifest, null), { force: true });

  const result = spawnSync(stryker, ['run', config, ...strykerArgs], {
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
  return runMutationResult(dir, null, io);
}
