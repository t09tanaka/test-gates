import { loadGates } from './load.js';
import { resolveRootDir } from './shared.js';

export interface StrykerGatesOptions {
  /** Directory of test-gates.json: `import.meta.url` of the config file, or a directory path. */
  rootDir?: string;
  /** Any other Stryker option: testRunner, jest / vitest, concurrency, ignorePatterns, … */
  [option: string]: unknown;
}

const WEAKENING_OPTIONS = ['ignoreStatic', 'ignorers'];

/**
 * Stryker config for the gates: mutate exactly the gates, never fail on the score
 * (`thresholds.break: null`), and write the JSON report that `test-gates mutation` judges.
 *
 * `mutate`, `thresholds.break` and `jsonReporter.fileName` are always set here, and `json` is
 * always among the reporters. Options that take mutants out of the evaluation are rejected.
 */
export function createStrykerGatesConfig(
  options: StrykerGatesOptions = {}
): Record<string, unknown> {
  const { rootDir: rootDirOption, ...overrides } = options;
  for (const option of WEAKENING_OPTIONS) {
    if (overrides[option] !== undefined) {
      throw new Error(
        `test-gates: "${option}" takes mutants out of the evaluation. Allow equivalent mutants one by one in test-gates.json (equivalentMutants) instead`
      );
    }
  }
  const mutator = overrides.mutator as { excludedMutations?: unknown[] } | undefined;
  if (Array.isArray(mutator?.excludedMutations) && mutator.excludedMutations.length > 0) {
    throw new Error(
      'test-gates: "mutator.excludedMutations" takes mutants out of the evaluation. Allow equivalent mutants one by one in test-gates.json (equivalentMutants) instead'
    );
  }
  const manifest = loadGates(resolveRootDir(rootDirOption));

  const reporters = Array.isArray(overrides.reporters)
    ? (overrides.reporters as unknown[])
    : ['clear-text', 'progress'];
  const thresholds =
    typeof overrides.thresholds === 'object' && overrides.thresholds !== null
      ? (overrides.thresholds as Record<string, unknown>)
      : { high: 100, low: 100 };
  const jsonReporter =
    typeof overrides.jsonReporter === 'object' && overrides.jsonReporter !== null
      ? (overrides.jsonReporter as Record<string, unknown>)
      : {};

  return {
    coverageAnalysis: 'perTest',
    incremental: true,
    incrementalFile: 'reports/stryker-incremental.json',
    tempDirName: '.stryker-tmp',
    clearTextReporter: { logTests: false, reportTests: false },
    ...overrides,
    mutate: manifest.gates.map((gate) => gate.path),
    thresholds: { ...thresholds, break: null },
    reporters: reporters.includes('json') ? reporters : [...reporters, 'json'],
    jsonReporter: { ...jsonReporter, fileName: manifest.settings.strykerReportFile },
  };
}
