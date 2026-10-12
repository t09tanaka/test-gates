import { createRequire } from 'node:module';
import path from 'node:path';
import { TOUCH_ENV, writeRunInfo, writeSpecNote } from './touch.js';

interface GlobalConfig {
  rootDir?: unknown;
  coverageProvider?: unknown;
  projects?: unknown;
}

/** Version of the Jest that runs, looked up from the project; "unknown" when it is not found. */
function jestVersion(rootDir: unknown): string {
  for (const name of ['jest/package.json', '@jest/core/package.json']) {
    try {
      const from = createRequire(path.join(typeof rootDir === 'string' ? rootDir : '.', 'x.js'));
      const { version } = from(name) as { version?: unknown };
      if (typeof version === 'string') {
        return version;
      }
    } catch {
      // try the next one
    }
  }
  return 'unknown';
}

/**
 * Jest reporter that `createJestGatesConfig` adds while `test-gates selfcheck` asks for it:
 * writes down what each spec file executed, from the coverage Jest itself collected for that
 * file, and how the run ran.
 */
export default class TouchReporter {
  constructor(globalConfig: GlobalConfig = {}) {
    const directory = process.env[TOUCH_ENV];
    if (directory) {
      writeRunInfo(directory, {
        runner: 'jest',
        version: jestVersion(globalConfig.rootDir),
        provider:
          typeof globalConfig.coverageProvider === 'string'
            ? globalConfig.coverageProvider
            : 'unknown',
        pool: 'default',
        isolate: true,
        // Without the `projects` option the list is empty, or names the one root.
        projects: Array.isArray(globalConfig.projects)
          ? Math.max(1, globalConfig.projects.length)
          : 0,
        problem: null,
      });
    }
  }

  onTestResult(_test: unknown, result: { testFilePath: string; coverage?: unknown }): void {
    const directory = process.env[TOUCH_ENV];
    if (directory) {
      writeSpecNote(directory, result.testFilePath, result.coverage);
    }
  }
}
