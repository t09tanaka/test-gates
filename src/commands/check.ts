import fs from 'node:fs';
import path from 'node:path';
import { MANIFEST_FILE } from '../core/manifest.js';
import { scanGateSource, scanSpecSource, scanStrykerConfig } from '../core/scan.js';
import { gateExtensionOf, looksLikeSpec } from '../core/spec-path.js';
import type { Violation } from '../core/types.js';
import { existsExact, readText } from '../fs.js';
import { readManifest, type LoadedManifest } from '../load.js';
import { type Io, printViolations } from './output.js';

export const STRYKER_CONFIG_NAMES = [
  'stryker.gates.config.mjs',
  'stryker.gates.config.js',
  'stryker.gates.config.cjs',
  'stryker.gates.config.json',
];

/** The Stryker config of the subproject, or null when there is none. */
export function findStrykerConfig(manifest: LoadedManifest): string | null {
  if (manifest.settings.strykerConfigFile !== null) {
    return manifest.settings.strykerConfigFile;
  }
  return STRYKER_CONFIG_NAMES.find((name) => fs.existsSync(path.join(manifest.dir, name))) ?? null;
}

function isPlainRelativePath(file: string): boolean {
  return (
    !path.isAbsolute(file) &&
    !/^[A-Za-z]:/.test(file) &&
    !file.includes('\\') &&
    !file.split('/').some((segment) => segment === '..' || segment === '.' || segment === '')
  );
}

/** Every static rule of the gates. Returns all violations, not just the first. */
export function checkGates(manifest: LoadedManifest): Violation[] {
  const { dir, settings } = manifest;
  const violations: Violation[] = [...manifest.violations];

  for (const gate of manifest.gates) {
    if (!isPlainRelativePath(gate.path)) {
      violations.push({
        file: MANIFEST_FILE,
        message: `${gate.path}: write the path relative to the subproject, with "/" and without ".."`,
      });
      continue;
    }
    if (gateExtensionOf(gate.path, settings.gateExtensions) === null) {
      violations.push({
        file: gate.path,
        message: `a gate must be one of ${settings.gateExtensions.join(' / ')} (settings.gateExtensions)`,
      });
      continue;
    }
    if (looksLikeSpec(gate.path, settings)) {
      violations.push({ file: gate.path, message: 'a spec cannot be a gate' });
      continue;
    }
    for (const rule of settings.impurePaths) {
      if (rule.regex.test(gate.path)) {
        violations.push({
          file: gate.path,
          message: `cannot be a gate (${rule.reason}). Move it to candidates`,
        });
      }
    }

    if (!existsExact(dir, gate.path)) {
      violations.push({
        file: gate.path,
        message: 'file not found (the check is case-sensitive)',
      });
      continue;
    }
    violations.push(...scanGateSource(gate.path, readText(dir, gate.path), settings));

    if (gate.specCandidates.length === 0) {
      continue; // settings.spec.suffixes is empty: the project has no spec convention
    }
    if (gate.existingSpecs.length === 0) {
      violations.push({
        file: gate.path,
        message: `spec not found (looked for ${gate.specCandidates.join(', ')}; the check is case-sensitive)`,
      });
      continue;
    }
    if (gate.existingSpecs.length > 1) {
      violations.push({
        file: gate.path,
        message: `more than one spec (${gate.existingSpecs.join(', ')}). Keep one, or narrow settings.spec.suffixes`,
      });
      continue;
    }
    const specPath = gate.existingSpecs[0] as string;
    violations.push(...scanSpecSource(gate.path, specPath, readText(dir, specPath), settings));
  }

  for (const candidate of manifest.candidates) {
    // A candidate may be a directory ("everything under src/services").
    if (!isPlainRelativePath(candidate.path) || !existsExact(dir, candidate.path, 'any')) {
      violations.push({
        file: MANIFEST_FILE,
        message: `${candidate.path}: candidate not found. Remove it, or fix the path`,
      });
    }
  }

  const strykerConfig = findStrykerConfig(manifest);
  if (strykerConfig !== null) {
    if (!fs.existsSync(path.join(dir, strykerConfig))) {
      violations.push({ file: strykerConfig, message: 'Stryker config not found' });
    } else {
      violations.push(...scanStrykerConfig(strykerConfig, readText(dir, strykerConfig)));
    }
  }

  return violations;
}

export function runCheck(dir: string, io: Io): number {
  const manifest = readManifest(dir);
  const violations = checkGates(manifest);
  if (violations.length > 0) {
    printViolations(io, 'check', violations);
    return 1;
  }
  io.out(
    `sekisho check: OK (${manifest.gates.length} gate(s), ${manifest.candidates.length} candidate(s))`
  );
  return 0;
}
