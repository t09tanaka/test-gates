import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { cleanup, project, repoRoot, testGatesAsync, write } from './helpers';
import { helper, strykerRuns } from './support/incremental';

afterAll(cleanup);

const H = "import { expect, it } from 'vitest';\n";

// `countUp` has two mutants that can never end; test-gates.json lists them as expected
// timeouts. A timeout may also come from a loaded machine, where the mutant would have
// survived, so a timeout is never taken over from the last run.
function fixture(): string {
  const dir = project({
    'package.json': { name: 'timeouts-fixture', private: true, type: 'module' },
    'test-gates.json': {
      gates: [
        {
          path: 'src/count.ts',
          decides: 'd',
          impact: 'i',
          expectedTimeouts: [
            {
              mutator: 'BlockStatement',
              original: '{ i += 1; }',
              replacement: '{}',
              reason: 'the loop no longer ends',
            },
            {
              mutator: 'AssignmentOperator',
              original: 'i += 1',
              replacement: 'i -= 1',
              reason: 'the loop no longer ends',
            },
          ],
        },
        { path: 'src/fee.ts', decides: 'd', impact: 'i' },
      ],
      candidates: [],
    },
    'src/count.ts':
      'export function countUp(n: number): number {\n  let i = 0;\n  while (i < n) {\n    i += 1;\n  }\n  return i;\n}\n',
    'src/count.spec.ts':
      `${H}import { countUp } from './count';\n` +
      "it('counts', () => {\n  expect(countUp(3)).toBe(3);\n  expect(countUp(0)).toBe(0);\n});\n",
    'src/fee.ts': 'export const fee = (kg: number) => (kg > 2 ? 9 : 5);\n',
    'src/fee.spec.ts':
      `${H}import { fee } from './fee';\n` +
      "it('goes by weight', () => {\n  expect(fee(2)).toBe(5);\n  expect(fee(3)).toBe(9);\n});\n",
    'vitest.gates.config.ts':
      `import { createVitestGatesConfig } from ${JSON.stringify(helper('vitest'))};\n` +
      'export default createVitestGatesConfig({ rootDir: import.meta.url });\n',
    'stryker.gates.config.mjs':
      `import { createStrykerGatesConfig } from ${JSON.stringify(helper('stryker'))};\n` +
      "export default createStrykerGatesConfig({ rootDir: import.meta.url, testRunner: 'vitest', " +
      "vitest: { configFile: 'vitest.gates.config.ts' }, concurrency: 1, timeoutMS: 1000 });\n",
  });
  fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  return dir;
}

/**
 * Turns the results of the comparison `kg > 2` of `fee` in the incremental file into timeouts,
 * as a loaded machine can leave them, and keeps the record of the run with it.
 */
async function timedOutUnderLoad(dir: string): Promise<void> {
  const file = path.join(dir, 'reports/stryker-incremental.json');
  const stored = JSON.parse(fs.readFileSync(file, 'utf8')) as {
    files: Record<string, { mutants: Array<{ mutatorName: string; status: string }> }>;
  };
  let changed = 0;
  for (const mutant of stored.files['src/fee.ts']?.mutants ?? []) {
    if (mutant.mutatorName === 'EqualityOperator' && mutant.status === 'Killed') {
      mutant.status = 'Timeout';
      changed += 1;
    }
  }
  expect(changed).toBeGreaterThan(0);
  fs.writeFileSync(file, JSON.stringify(stored));
  // The record has to belong to the incremental file as it is now.
  const record = `${file}.test-gates.json`;
  const kept = JSON.parse(fs.readFileSync(record, 'utf8')) as { incremental: string };
  const { createHash } = await import('node:crypto');
  kept.incremental = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  fs.writeFileSync(record, JSON.stringify(kept));
}

describe.skipIf(!strykerRuns)('mutants that timed out in the last run, with a real Stryker', () => {
  it(
    'are run again also in a gate whose other results are reused, with and without --affected',
    { timeout: 300_000 },
    async () => {
      const dir = fixture();
      const run = (...args: string[]) => testGatesAsync(['mutation', '--dir', dir, ...args]);

      const first = await run('--affected');
      expect(first.stdout).toContain(
        '(timeout 2) / allowed equivalent 0 / not evaluable 0 / unallowed survivors 0)'
      );
      expect(first.status).toBe(0);

      // Nothing changed: both gates are reused, but the two timeouts are run again.
      const second = await run('--affected');
      expect(second.stdout).toContain(
        'test-gates mutation --affected: 2 of 2 gate(s) reused, 0 run again'
      );
      expect(second.stdout).toContain(
        '  and 2 mutant(s) of reused gates that timed out in the last run'
      );
      expect(second.stdout).toContain(
        '(timeout 2) / allowed equivalent 0 / not evaluable 0 / unallowed survivors 0)'
      );
      expect(second.status).toBe(0);

      // A gate that is run again for a change, next to one whose timeouts are run again.
      write(dir, { 'src/fee.ts': 'export const fee = (kg: number) => (kg > 2 ? 9 : 5); // x\n' });
      const both = await run('--affected');
      expect(both.stdout).toContain('1 of 2 gate(s) reused, 1 run again');
      expect(both.stdout).toContain('  src/fee.ts: changed src/fee.ts');
      expect(both.stdout).toContain('  and 2 mutant(s) of reused gates that timed out');
      expect(both.stdout).toContain(
        '(timeout 2) / allowed equivalent 0 / not evaluable 0 / unallowed survivors 0)'
      );

      // Timeouts left by a loaded machine are not taken over: run again, the mutants are killed.
      await timedOutUnderLoad(dir);
      const loaded = await run('--affected');
      expect(loaded.stdout).toContain('2 of 2 gate(s) reused, 0 run again');
      expect(loaded.stdout).toMatch(/ {2}and [3-9] mutant\(s\) of reused gates that timed out/);
      expect(loaded.stdout).toContain(
        '(timeout 2) / allowed equivalent 0 / not evaluable 0 / unallowed survivors 0)'
      );
      expect(loaded.status).toBe(0);

      // Without --affected, a run after no change runs its timeouts again as well.
      await timedOutUnderLoad(dir);
      const plain = await run();
      expect(plain.stdout).toMatch(
        /test-gates mutation: [3-9] mutant\(s\) that timed out in the last run are run again, the other results are reused/
      );
      expect(plain.stdout).toContain(
        '(timeout 2) / allowed equivalent 0 / not evaluable 0 / unallowed survivors 0)'
      );
      expect(plain.status).toBe(0);
    }
  );
});
