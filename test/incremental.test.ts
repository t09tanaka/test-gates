import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { cleanup, project, repoRoot, testGates, write } from './helpers';

afterAll(cleanup);

// A real Stryker run. Stryker 10 does not start below Node.js 22.12.
const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
const strykerRuns = major > 22 || (major === 22 && minor >= 12);

const helper = (name: string) => pathToFileURL(path.join(repoRoot, 'dist', `${name}.js`)).href;
const gate = (file: string) => ({ path: file, decides: 'd', impact: 'i' });
const SPEC_HEAD = "import { expect, it } from 'vitest';\nimport { has } from './kinds';\n";
const KNOWS_A =
  "it('knows a', () => { expect(has('a')).toBe(true); expect(has('z')).toBe(false); });\n";
const KNOWS_B =
  "it('knows b', () => { expect(has('b')).toBe(true); expect(has('')).toBe(false); });\n";

function report(dir: string, file: string): Record<string, { status: string }[]> {
  const parsed = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) as {
    files: Record<string, { mutants: { status: string }[] }>;
  };
  return Object.fromEntries(
    Object.entries(parsed.files).map(([name, value]) => [name, value.mutants])
  );
}

describe.skipIf(!strykerRuns)('test-gates mutation with the Stryker incremental file', () => {
  it(
    'judges a fully reused run, shows the stale static survivor, and ignores a removed gate',
    { timeout: 240_000 },
    () => {
      const dir = project({
        'package.json': { name: 'incremental-fixture', private: true, type: 'module' },
        'test-gates.json': { gates: [gate('src/kinds.ts'), gate('src/age.ts')], candidates: [] },
        // `KINDS` is evaluated when the module loads: its mutants are static.
        'src/kinds.ts':
          "const KINDS = ['a', 'b'];\nexport const has = (kind: string) => KINDS.includes(kind);\n",
        'src/kinds.spec.ts': SPEC_HEAD + KNOWS_A,
        'src/age.ts': 'export const isAdult = (age: number) => age >= 18;\n',
        'src/age.spec.ts':
          "import { expect, it } from 'vitest';\nimport { isAdult } from './age';\n" +
          "it('is adult from 18', () => { expect(isAdult(18)).toBe(true); expect(isAdult(17)).toBe(false); });\n",
        'vitest.gates.config.ts':
          `import { createVitestGatesConfig } from ${JSON.stringify(helper('vitest'))};\n` +
          'export default createVitestGatesConfig({ rootDir: import.meta.url });\n',
        'stryker.gates.config.mjs':
          `import { createStrykerGatesConfig } from ${JSON.stringify(helper('stryker'))};\n` +
          "export default createStrykerGatesConfig({ rootDir: import.meta.url, testRunner: 'vitest', " +
          "vitest: { configFile: 'vitest.gates.config.ts' }, concurrency: 1 });\n",
      });
      fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
      const run = (...args: string[]) => testGates(['mutation', '--dir', dir, ...args]);
      const SURVIVOR = '  - src/kinds.ts:1:21 / StringLiteral / \'b\' → "" (Survived)';
      const FAILED =
        'test-gates mutation: FAILED (mutants 9 / detected 8 (timeout 0) / allowed equivalent 0 / not evaluable 0 / unallowed survivors 1)';
      const PASSED =
        'test-gates mutation: OK (mutants 9 / detected 9 (timeout 0) / allowed equivalent 0 / not evaluable 0 / unallowed survivors 0)';

      // 1. First run: nothing to reuse. The spec never asks for 'b', so one mutant survives.
      const first = run();
      expect(first.status).toBe(1);
      expect(first.stderr).toContain(SURVIVOR);
      expect(first.stderr).toContain(FAILED);
      expect(fs.existsSync(path.join(dir, 'reports/stryker-incremental.json'))).toBe(true);

      // 2. Nothing changed: every result is reused, and the JSON report is still complete.
      const second = run();
      expect(second.stdout).toContain('9 of 9 mutant result(s) are reused');
      expect(second.status).toBe(1);
      expect(second.stderr).toContain(FAILED);
      expect(report(dir, 'reports/mutation/mutation.json')['src/kinds.ts']).toHaveLength(4);
      expect(report(dir, 'reports/mutation/mutation.json')['src/age.ts']).toHaveLength(5);

      // 3. A test that kills the survivor is added. The mutant is static, and the incremental
      //    run reuses its old "Survived": a false failure, never a false pass.
      write(dir, { 'src/kinds.spec.ts': SPEC_HEAD + KNOWS_A + KNOWS_B });
      const third = run();
      expect(third.status).toBe(1);
      expect(third.stderr).toContain(SURVIVOR);

      // 4. --force retests everything and the run passes.
      const forced = run('--force');
      expect(forced.stdout).toContain('0 of 9 mutant result(s) are reused');
      expect(forced.stdout).toContain(PASSED);
      expect(forced.status).toBe(0);

      // 5. A gate is removed. Its old results stay in the incremental file and come back in
      //    the report, but only the gates of test-gates.json are judged.
      write(dir, { 'test-gates.json': { gates: [gate('src/kinds.ts')], candidates: [] } });
      const removed = run();
      expect(removed.status).toBe(0);
      expect(removed.stdout).toContain(
        'test-gates mutation: OK (mutants 4 / detected 4 (timeout 0) / allowed equivalent 0 / not evaluable 0 / unallowed survivors 0)'
      );
      expect(Object.keys(report(dir, 'reports/mutation/mutation.json')).sort()).toEqual([
        'src/age.ts',
        'src/kinds.ts',
      ]);
    }
  );
});
