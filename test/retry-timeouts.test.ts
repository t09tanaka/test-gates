import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { cleanup, project, repoRoot, testGatesAsync } from './helpers';
import { gate, helper, report, strykerRuns } from './support/incremental';

afterAll(cleanup);

// One gate. Its spec blocks for longer than Stryker's timeout when a mutant makes `fee(2)` wrong
// and a marker file is there: `once` is taken away by the first mutant that sees it, as a
// loaded machine can slow one mutant down; `always` stays.
function fixture(markers: string): string {
  const once = JSON.stringify(path.join(markers, 'once'));
  const always = JSON.stringify(path.join(markers, 'always'));
  const dir = project({
    'package.json': { name: 'retry-fixture', private: true, type: 'module' },
    'test-gates.json': { gates: [gate('src/fee.ts')], candidates: [] },
    'src/fee.ts': 'export const fee = (kg: number) => (kg > 2 ? 9 : 5);\n',
    'src/fee.spec.ts':
      "import fs from 'node:fs';\nimport { expect, it } from 'vitest';\nimport { fee } from './fee';\n" +
      'const block = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10_000);\n' +
      "it('goes by weight', () => {\n  const light = fee(2);\n  if (light !== 5) {\n" +
      `    if (fs.existsSync(${always})) block();\n` +
      `    else if (fs.existsSync(${once})) {\n      fs.rmSync(${once});\n      block();\n    }\n  }\n` +
      '  expect(light).toBe(5);\n  expect(fee(3)).toBe(9);\n});\n',
    'vitest.gates.config.ts':
      `import { createVitestGatesConfig } from ${JSON.stringify(helper('vitest'))};\n` +
      'export default createVitestGatesConfig({ rootDir: import.meta.url });\n',
    'stryker.gates.config.mjs':
      `import { createStrykerGatesConfig } from ${JSON.stringify(helper('stryker'))};\n` +
      "export default createStrykerGatesConfig({ rootDir: import.meta.url, testRunner: 'vitest', " +
      "vitest: { configFile: 'vitest.gates.config.ts' }, concurrency: 2, timeoutMS: 1000 });\n",
  });
  fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  return dir;
}

const statuses = (dir: string, file: string) =>
  (report(dir, file)['src/fee.ts'] ?? []).map((mutant) => mutant.status);

describe.skipIf(!strykerRuns)('timeouts of the run, with a real Stryker', () => {
  it(
    'are run again once, one at a time: a mutant that is killed then passes, one that times out again fails',
    { timeout: 300_000 },
    async () => {
      const markers = project({ once: '' });
      const dir = fixture(markers);
      const run = (...args: string[]) => testGatesAsync(['mutation', '--dir', dir, ...args]);

      // 1. One mutant times out in the run, and is killed in the run again.
      const first = await run();
      expect(first.stdout).toContain(
        'test-gates mutation: 1 mutant(s) timed out outside expectedTimeouts, running them again one at a time (--concurrency 1)'
      );
      expect(first.stdout).toContain(
        'test-gates mutation: 1 mutant(s) that timed out were run again one at a time (--concurrency 1): 1 Killed'
      );
      expect(first.stdout).toContain(
        '(timeout 0) / allowed equivalent 0 / not evaluable 0 / unallowed survivors 0)'
      );
      expect(first.status).toBe(0);
      expect(fs.existsSync(path.join(markers, 'once'))).toBe(false);
      // The incremental file holds the result of the run again, not the timeout...
      const incremental = statuses(dir, 'reports/stryker-incremental.json');
      expect(incremental.length).toBeGreaterThan(1);
      expect(incremental.filter((status) => status !== 'Killed')).toEqual([]);
      expect(statuses(dir, 'reports/mutation/mutation.json')).toEqual(incremental);

      // ...so the next run takes it over, and runs nothing again.
      const next = await run();
      expect(next.stdout).not.toContain('timed out');
      expect(next.stdout).toContain(
        '(timeout 0) / allowed equivalent 0 / not evaluable 0 / unallowed survivors 0)'
      );
      expect(next.status).toBe(0);

      // 2. The mutants time out in the run again as well: the run fails as without it.
      fs.writeFileSync(path.join(markers, 'always'), '');
      const stuck = await run('--', '--force');
      const timedOut = /(\d+) mutant\(s\) timed out outside expectedTimeouts/.exec(
        stuck.stdout
      )?.[1];
      expect(Number(timedOut)).toBeGreaterThan(0);
      expect(stuck.stdout).toContain(
        `test-gates mutation: ${timedOut} mutant(s) that timed out were run again one at a time (--concurrency 1): ${timedOut} Timeout`
      );
      expect(stuck.stderr).toContain(
        `test-gates mutation: ${timedOut} mutant(s) timed out (settings.mutation.maxTimeouts: 0)`
      );
      expect(stuck.status).toBe(1);
    }
  );
});
