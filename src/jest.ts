import path from 'node:path';
import { gateSpecs, loadGates } from './load.js';
import { FULL_COVERAGE, resolveRootDir } from './shared.js';

export interface JestGatesOptions {
  /** Directory of test-gates.json: `__dirname`, or `import.meta.url` of the config file. */
  rootDir?: string;
  /** Any other Jest option: transform, moduleNameMapper, cacheDirectory, … */
  [option: string]: unknown;
}

/**
 * Jest config for the gate run: only the specs of the gates, only the gates measured, every
 * gate at 100% on all four metrics.
 *
 * The keys that make it a gate (`testMatch`, `collectCoverage`, `collectCoverageFrom`,
 * `coverageProvider`, `coverageThreshold`) are always set here and win over `options`.
 * `coverageProvider` is `babel` (istanbul): v8 does not count the untaken side of an `if`
 * without `else`. Threshold keys are absolute paths; Jest fails on a key that matches no file,
 * so a typo in test-gates.json cannot pass silently.
 */
export function createJestGatesConfig(options: JestGatesOptions = {}): Record<string, unknown> {
  const { rootDir: rootDirOption, ...overrides } = options;
  const rootDir = resolveRootDir(rootDirOption);
  const manifest = loadGates(rootDir);

  return {
    testEnvironment: 'node',
    coverageReporters: ['text'],
    coverageDirectory: '<rootDir>/coverage/gates',
    ...overrides,
    rootDir,
    testMatch: gateSpecs(manifest).map((spec) => `<rootDir>/${spec}`),
    collectCoverage: true,
    coverageProvider: 'babel',
    collectCoverageFrom: manifest.gates.map((gate) => `<rootDir>/${gate.path}`),
    coverageThreshold: Object.fromEntries(
      manifest.gates.map((gate) => [path.join(rootDir, gate.path), { ...FULL_COVERAGE }])
    ),
  };
}
