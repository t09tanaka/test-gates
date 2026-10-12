import { TOUCH_ENV, writeTouchRecord } from './touch.js';

/**
 * Jest reporter that `createJestGatesConfig` adds while `test-gates selfcheck` asks for it:
 * writes down which measured files each spec file executed, from the coverage Jest itself
 * collected for that file.
 */
export default class TouchReporter {
  onTestResult(_test: unknown, result: { testFilePath: string; coverage?: unknown }): void {
    const directory = process.env[TOUCH_ENV];
    if (directory) {
      writeTouchRecord(directory, result.testFilePath, result.coverage);
    }
  }
}
