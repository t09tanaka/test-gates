import path from 'node:path';
import { gateSpecs, loadGates, NO_SPEC_PATTERN } from './load.js';
import { FULL_COVERAGE, resolveRootDir } from './shared.js';
import { jestReporterFile, TOUCH_ENV } from './touch.js';

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
 * The keys that make it a gate (`testMatch`, `passWithNoTests`, `collectCoverage`,
 * `collectCoverageFrom`, `coverageProvider`, `coverageThreshold`) are always set here and win
 * over `options`.
 * `coverageProvider` is `babel` (istanbul): v8 does not count the untaken side of an `if`
 * without `else`. Threshold keys are absolute paths; Jest fails on a key that matches no file,
 * so a typo in test-gates.json cannot pass silently.
 */
export function createJestGatesConfig(options: JestGatesOptions = {}): Record<string, unknown> {
  const { rootDir: rootDirOption, ...overrides } = options;
  const rootDir = resolveRootDir(rootDirOption);
  const manifest = loadGates(rootDir);
  const specs = gateSpecs(manifest);

  return {
    testEnvironment: 'node',
    coverageReporters: ['text'],
    coverageDirectory: '<rootDir>/coverage/gates',
    ...overrides,
    // While `test-gates selfcheck` asks for it: write down what each spec executed.
    ...(process.env[TOUCH_ENV]
      ? {
          reporters: [
            ...(Array.isArray(overrides.reporters)
              ? (overrides.reporters as unknown[])
              : ['default']),
            jestReporterFile(import.meta.url),
          ],
          // The runner's own total, to check the notes against.
          coverageReporters: [
            ...(Array.isArray(overrides.coverageReporters)
              ? (overrides.coverageReporters as unknown[])
              : ['text']),
            'json',
          ],
          coverageDirectory: path.join(process.env[TOUCH_ENV], 'coverage'),
        }
      : {}),
    rootDir,
    // Never an empty array: Jest would fall back to its default pattern and run every test.
    testMatch: (specs.length > 0 ? specs : [NO_SPEC_PATTERN]).map((spec) => `<rootDir>/${spec}`),
    // With no spec left (`test-gates selfcheck` on a single-gate project) the run must fail on the
    // missing coverage of the gate, not on "No tests found".
    passWithNoTests: true,
    collectCoverage: true,
    coverageProvider: 'babel',
    collectCoverageFrom: manifest.gates.map((gate) => `<rootDir>/${gate.path}`),
    coverageThreshold: Object.fromEntries(
      manifest.gates.map((gate) => [path.join(rootDir, gate.path), { ...FULL_COVERAGE }])
    ),
  };
}
