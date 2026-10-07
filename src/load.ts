import fs from 'node:fs';
import path from 'node:path';
import { MANIFEST_FILE, ManifestError, parseManifest } from './core/manifest.js';
import { resolveSettings, SettingsError } from './core/settings.js';
import { EXCLUDE_ENV } from './core/selfcheck.js';
import { specCandidatesFor } from './core/spec-path.js';
import type { Candidate, Gate, ResolvedSettings, Violation } from './core/types.js';
import { existsExact } from './fs.js';

export interface ResolvedGate extends Gate {
  /** Where the spec may live, in order of preference (relative to the subproject). */
  specCandidates: string[];
  /**
   * The spec that exists. When none exists this is the first candidate, so that a config built
   * from it fails on the missing coverage instead of silently dropping the gate. `null` only
   * when the project has no spec convention (`settings.spec.suffixes: []`).
   */
  spec: string | null;
  /** Every candidate that exists. More than one is ambiguous and `sekisho check` rejects it. */
  existingSpecs: string[];
}

export interface LoadedManifest {
  /** Absolute path of the subproject. */
  dir: string;
  gates: ResolvedGate[];
  candidates: Candidate[];
  settings: ResolvedSettings;
  /** Problems inside the manifest entries (`sekisho check` reports them). */
  violations: Violation[];
}

/** Reads `<dir>/test-gates.json`. Throws ManifestError when it cannot be used at all. */
export function readManifest(dir: string): LoadedManifest {
  const absoluteDir = path.resolve(dir);
  const manifestPath = path.join(absoluteDir, MANIFEST_FILE);
  let text: string;
  try {
    text = fs.readFileSync(manifestPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ManifestError(`${MANIFEST_FILE} not found in ${absoluteDir}`);
    }
    throw new ManifestError(`cannot read ${manifestPath}: ${(error as Error).message}`);
  }
  const parsed = parseManifest(text);
  let settings: ResolvedSettings;
  try {
    settings = resolveSettings(parsed.settings);
  } catch (error) {
    if (error instanceof SettingsError) {
      throw new ManifestError(`${MANIFEST_FILE}: ${error.message}`);
    }
    throw error;
  }

  const gates = parsed.gates.map((gate) => {
    const specCandidates = specCandidatesFor(gate.path, settings);
    const existingSpecs = specCandidates.filter((candidate) => existsExact(absoluteDir, candidate));
    return {
      ...gate,
      specCandidates,
      existingSpecs,
      spec: existingSpecs[0] ?? specCandidates[0] ?? null,
    };
  });

  return {
    dir: absoluteDir,
    gates,
    candidates: parsed.candidates,
    settings,
    violations: parsed.violations,
  };
}

/**
 * Reads and validates `<dir>/test-gates.json` for use in a config file.
 * Throws when the manifest has any structural problem: a config derived from a broken list
 * would gate the wrong set of files.
 */
export function loadGates(dir: string = process.cwd()): LoadedManifest {
  const manifest = readManifest(dir);
  if (manifest.violations.length > 0) {
    throw new ManifestError(
      `${MANIFEST_FILE} has problems (run "sekisho check"):\n` +
        manifest.violations.map((violation) => `  - ${violation.message}`).join('\n')
    );
  }
  return manifest;
}

/**
 * Specs the gate run executes: the spec of every gate, minus the one `sekisho selfcheck`
 * asks to leave out through SEKISHO_EXCLUDE_SPEC.
 */
export function gateSpecs(
  manifest: LoadedManifest,
  env: Record<string, string | undefined> = process.env
): string[] {
  const excluded = env[EXCLUDE_ENV];
  return manifest.gates
    .map((gate) => gate.spec)
    .filter((spec): spec is string => spec !== null && spec !== excluded);
}
