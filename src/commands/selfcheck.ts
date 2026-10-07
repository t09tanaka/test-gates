import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ManifestError } from '../core/manifest.js';
import { findImporters } from '../core/import-policy.js';
import { EXCLUDE_ENV, judgeSelfcheck } from '../core/selfcheck.js';
import { existsExact, findLocalBin, readText } from '../fs.js';
import { readManifest, type LoadedManifest } from '../load.js';
import type { Io } from './output.js';

const JEST_CONFIGS = ['js', 'cjs', 'mjs', 'ts', 'cts', 'mts'].map(
  (extension) => `jest.gates.config.${extension}`
);
const VITEST_CONFIGS = ['ts', 'mts', 'cts', 'js', 'mjs', 'cjs'].map(
  (extension) => `vitest.gates.config.${extension}`
);

/** The command that runs the gate: settings.gateCommand, or derived from the gate config file. */
export function resolveGateCommand(manifest: LoadedManifest): string[] {
  if (manifest.settings.gateCommand !== null) {
    return manifest.settings.gateCommand;
  }
  const exists = (name: string) => fs.existsSync(path.join(manifest.dir, name));
  const jest = JEST_CONFIGS.find(exists);
  const vitest = VITEST_CONFIGS.find(exists);
  if (jest && vitest) {
    throw new ManifestError(
      `both ${jest} and ${vitest} exist. Set settings.gateCommand to say which one runs the gate`
    );
  }
  if (jest) {
    return ['jest', '--config', jest];
  }
  if (vitest) {
    return ['vitest', 'run', '--config', vitest];
  }
  throw new ManifestError(
    'no gate config found (jest.gates.config.* / vitest.gates.config.*). Set settings.gateCommand'
  );
}

/**
 * Negative control. Runs the gate with the spec of one gate left out and requires it to fail
 * on the coverage threshold of that gate. A gate that stays green without its spec measures
 * nothing.
 */
export function runSelfcheck(
  dir: string,
  mode: 'all' | 'first' | null,
  commandOverride: string[],
  io: Io
): number {
  const manifest = readManifest(dir);
  if (manifest.violations.length > 0 || manifest.gates.length === 0) {
    io.err('test-gates selfcheck: test-gates.json has problems. Run "test-gates check" first');
    return 1;
  }
  const command = commandOverride.length > 0 ? commandOverride : resolveGateCommand(manifest);
  const [program, ...args] = command as [string, ...string[]];
  const executable = findLocalBin(manifest.dir, program) ?? program;
  const targets =
    (mode ?? manifest.settings.selfcheckMode) === 'first'
      ? manifest.gates.slice(0, 1)
      : manifest.gates;

  let failed = 0;
  for (const gate of targets) {
    if (gate.spec === null || gate.existingSpecs.length !== 1) {
      io.err(`  ✗ ${gate.path}: no single spec to leave out. Run "test-gates check"`);
      failed += 1;
      continue;
    }
    const result = spawnSync(executable, args, {
      cwd: manifest.dir,
      env: { ...process.env, [EXCLUDE_ENV]: gate.spec },
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      shell: process.platform === 'win32',
    });
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    const reason = result.error
      ? `cannot start "${command.join(' ')}" (${result.error.message})`
      : judgeSelfcheck({
          status: result.status,
          output,
          gatePath: gate.path,
          failurePattern: manifest.settings.selfcheckFailurePattern,
        });
    if (reason === null) {
      io.out(`  ✓ without ${gate.spec} the gate fails (exit ${result.status})`);
    } else {
      failed += 1;
      io.err(`  ✗ ${gate.path}: ${reason}`);
      if (result.status === 0) {
        // The usual cause in a project whose config does honor the variable: another gate
        // imports this one, so that gate's spec covers it.
        const importers = findImporters(
          gate.path,
          manifest.gates
            .filter((other) => existsExact(manifest.dir, other.path))
            .map((other) => ({ path: other.path, source: readText(manifest.dir, other.path) })),
          manifest.settings.importAliases
        );
        if (importers.length > 0) {
          io.err(
            `      hint: ${importers.join(', ')} import(s) this gate, so their specs cover it without its own spec. ` +
              'Mock the import in those specs and assert the call (toHaveBeenCalledWith), so that each spec only covers its own gate'
          );
        }
      }
      const tail = output.trimEnd().split('\n').slice(-25).join('\n');
      if (tail !== '') {
        io.err(tail.replace(/^/gm, '      '));
      }
    }
  }

  if (failed > 0) {
    io.err(`test-gates selfcheck: FAILED (${failed} of ${targets.length} negative control(s))`);
    return 1;
  }
  io.out(`test-gates selfcheck: OK (${targets.length} negative control(s) failed as they should)`);
  return 0;
}
