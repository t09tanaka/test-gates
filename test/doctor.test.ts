import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { cleanup, project, testGates, write } from './helpers';

afterAll(cleanup);

// A path that goes up one directory. Put together here, because written out in this file it
// would be a path that leads out of this repository, and the snapshot of this repository reads
// this file too.
const UP = ['..', ''].join('/');

function git(dir: string, ...args: string[]): void {
  const result = spawnSync(
    'git',
    [
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@example.invalid',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { cwd: dir, encoding: 'utf8' }
  );
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  }
}

/** A repository with the subproject `fee-rules`, a sibling package, and a pre-push hook. */
function repository(files: Record<string, string | object> = {}): string {
  const root = project({
    '.gitignore': 'node_modules\nreports\n.stryker-tmp\n',
    'package.json': { name: 'root', private: true, workspaces: ['fee-rules'] },
    'catalog-site/src/listing.ts': 'export const listing = 1;\n',
    'node_modules/vitest/package.json': '{ "name": "vitest" }',
    '.husky/pre-push': 'cd fee-rules && npm run test:gates:mutation\n',
    'fee-rules/package.json': {
      name: 'fee-rules',
      scripts: { 'test:gates:mutation': 'test-gates mutation' },
    },
    'fee-rules/test-gates.json': {
      gates: [{ path: 'src/fee.ts', decides: 'a fee', impact: 'a wrong fee' }],
      candidates: [],
    },
    'fee-rules/stryker.gates.config.mjs':
      "export default { incremental: true, testRunner: 'vitest', vitest: { configFile: 'vitest.gates.config.ts' } };\n",
    'fee-rules/vitest.gates.config.ts':
      "import { createVitestGatesConfig } from '@t09tanaka/test-gates/vitest';\nexport default createVitestGatesConfig();\n",
    'fee-rules/src/fee.ts': 'export const fee = (x: number) => x + 1;\n',
    'fee-rules/src/fee.spec.ts':
      "import { expect, it } from 'vitest';\nimport { fee } from './fee';\nit('fee', () => { expect(fee(1)).toBe(2); });\n",
    ...files,
  });
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'first');
  return root;
}

const doctor = (root: string) => testGates(['doctor', '--dir', path.join(root, 'fee-rules')]);

describe('test-gates doctor', () => {
  it('names a hook that runs mutation without --affected, and fails', () => {
    const result = doctor(repository());
    expect(result.stdout).toContain('paths followed in the 5 files the run loads');
    expect(result.stdout).toContain('next run: every mutant, there is no incremental file');
    expect(result.stdout).toContain(
      'problem: .husky/pre-push runs test-gates mutation without --affected'
    );
    expect(result.stdout).toContain('test-gates doctor: 1 problem(s) that make runs full ones');
    expect(result.status).toBe(1);
  });

  it('passes when the script the hook runs is given --affected', () => {
    const root = repository({
      'fee-rules/package.json': {
        name: 'fee-rules',
        scripts: { 'test:gates:mutation': 'test-gates mutation --affected' },
      },
    });
    const result = doctor(root);
    expect(result.stdout).toContain('test-gates doctor: OK');
    expect(result.status).toBe(0);
  });

  it('names the file whose path makes every file of the repository compared', () => {
    const root = repository({
      '.husky/pre-push': 'cd fee-rules && npx test-gates mutation --affected\n',
      'fee-rules/vitest.gates.config.ts': 'export default { test: {} };\n',
      'fee-rules/eslint.config.js': `export default { patterns: ['${UP}'] };\n`,
    });
    const result = doctor(root);
    expect(result.stdout).toContain(
      `every file of the repository is compared, so a change anywhere in it makes the next run a full one. Because of: fee-rules/eslint.config.js "${UP}"`
    );
    expect(result.stdout).toContain(
      'note: the paths in every file of the subproject are followed, also in files the run does not load: the runner config is not made with createJestGatesConfig or createVitestGatesConfig'
    );
    expect(result.status).toBe(1);
  });

  it('changes nothing on disk, also with the record of a run there', () => {
    const root = repository();
    const written = {
      'fee-rules/reports/stryker-incremental.json': '{}',
      'fee-rules/reports/stryker-incremental.json.test-gates.json': '{"format":2}',
      'fee-rules/reports/mutation/mutation.json': '{}',
      'fee-rules/.stryker-tmp/x': 'x',
    };
    write(root, written);
    doctor(root);
    for (const [file, content] of Object.entries(written)) {
      expect(fs.readFileSync(path.join(root, file), 'utf8')).toBe(content);
    }
  });

  it('takes no hook for a problem of the subproject when it runs another one, or only a judgement', () => {
    const root = repository({
      '.husky/pre-push':
        'cd catalog-site && npx test-gates mutation\nnpx test-gates mutation-result --dir fee-rules\n',
    });
    const result = doctor(root);
    expect(result.stdout).toContain(
      'note: no git hook runs test-gates mutation for this subproject'
    );
    expect(result.stdout).toContain('test-gates doctor: OK');
    expect(result.status).toBe(0);
  });

  it('names what keeps --affected from telling the gates apart, instead of asking for it', () => {
    const blind = {
      'fee-rules/src/fee.spec.ts':
        "import { expect, it } from 'vitest';\nimport { fee } from './fee';\nimport { cases } from './cases';\nit('fee', () => { expect(fee(cases.length)).toBeGreaterThan(0); });\n",
      'fee-rules/src/cases.ts':
        "import { readdirSync } from 'node:fs';\nexport const cases = readdirSync(new URL('.', import.meta.url));\n",
    };
    const without = doctor(repository(blind));
    expect(without.stdout).toContain(
      'note: with --affected, a change of any file runs 1 of 1 gate(s) again (src/fee.ts): what they depend on cannot be told (src/cases.ts'
    );
    expect(without.stdout).not.toContain('runs test-gates mutation without --affected');
    expect(without.status).toBe(0);
    const relying = doctor(
      repository({
        ...blind,
        '.husky/pre-push': 'cd fee-rules && npx test-gates mutation --affected\n',
      })
    );
    expect(relying.stdout).toContain(
      'problem: with --affected, a change of any file runs 1 of 1 gate(s) again'
    );
    expect(relying.status).toBe(1);
  });

  it('names a Stryker config that sets force', () => {
    const root = repository({
      '.husky/pre-push': 'cd fee-rules && npx test-gates mutation --affected\n',
      'fee-rules/stryker.gates.config.mjs':
        "export default { incremental: true, force: true, testRunner: 'vitest', vitest: { configFile: 'vitest.gates.config.ts' } };\n",
    });
    write(root, { 'fee-rules/reports/stryker-incremental.json': '{}' });
    const result = doctor(root);
    expect(result.stdout).toContain('next run: every mutant, the Stryker config sets force');
    expect(result.stdout).toContain('problem: the Stryker config sets force');
    expect(result.status).toBe(1);
  });
});
