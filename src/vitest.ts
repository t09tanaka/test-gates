import { gateSpecs, loadGates, NO_SPEC_PATTERN } from './load.js';
import { FULL_COVERAGE, resolveRootDir } from './shared.js';

export interface VitestGatesOptions {
  /** Directory of test-gates.json: `__dirname`, or `import.meta.url` of the config file. */
  rootDir?: string;
  /** `test` options of Vitest. `include` and `coverage.include/thresholds/enabled` are owned by the helper. */
  test?: Record<string, unknown> & { coverage?: Record<string, unknown> };
  /** Any other Vite option: resolve.alias, esbuild, plugins, … */
  [option: string]: unknown;
}

/**
 * Vitest config for the gate run: only the specs of the gates, only the gates measured, every
 * gate at 100% on all four metrics (`thresholds.perFile`).
 *
 * Glob or path keys are deliberately not used in `thresholds`: Vitest passes when such a key
 * matches no file. Pass the result to `defineConfig`.
 */
export function createVitestGatesConfig(options: VitestGatesOptions = {}): Record<string, unknown> {
  const { rootDir: rootDirOption, test = {}, ...overrides } = options;
  const rootDir = resolveRootDir(rootDirOption);
  const manifest = loadGates(rootDir);
  const { coverage = {}, ...testOverrides } = test;
  const specs = gateSpecs(manifest);

  return {
    ...overrides,
    root: rootDir,
    test: {
      environment: 'node',
      ...testOverrides,
      include: specs.length > 0 ? specs : [NO_SPEC_PATTERN],
      // `test-gates selfcheck` leaves out the only spec of a single-gate project; the run must
      // then fail on the coverage threshold, not on "no test files found".
      passWithNoTests: true,
      coverage: {
        provider: 'v8',
        reporter: ['text'],
        reportsDirectory: 'coverage/gates',
        ...coverage,
        enabled: true,
        include: manifest.gates.map((gate) => gate.path),
        thresholds: { perFile: true, ...FULL_COVERAGE },
      },
    },
  };
}
