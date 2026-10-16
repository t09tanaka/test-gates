import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { gitEnvironment } from '../src/snapshot';
import { cleanup, cliPath, GATE_SOURCE, gateEntry, project, report, SPEC_SOURCE } from './helpers';

afterAll(cleanup);

describe('gitEnvironment', () => {
  it('leaves GIT_DIR out when GIT_WORK_TREE is not set, and nothing else', () => {
    expect(gitEnvironment({ GIT_DIR: '/r/.git/worktrees/w', PATH: '/bin' })).toEqual({
      PATH: '/bin',
    });
    const both = { GIT_DIR: '/r/.git', GIT_WORK_TREE: '/r', PATH: '/bin' };
    expect(gitEnvironment(both)).toEqual(both);
    expect(gitEnvironment({ PATH: '/bin' })).toEqual({ PATH: '/bin' });
  });
});

const outside = { ...process.env, CI: '' };
delete outside.GIT_DIR;
delete outside.GIT_WORK_TREE;
const git = (cwd: string, ...args: string[]) => {
  const result = spawnSync(
    'git',
    ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', ...args],
    { cwd, encoding: 'utf8', env: outside }
  );
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
};

// A hook of a linked worktree runs with GIT_DIR set and without GIT_WORK_TREE. In it, the
// subproject must not look like the top of the repository: the path to its sibling would lead
// outside, and no result would ever be reused.
describe('test-gates mutation --affected from a git hook of a linked worktree', () => {
  it('lists the files from the top of the repository, and reuses the results', () => {
    // A stand-in for Stryker: writes the report and a new incremental file.
    const stryker =
      "#!/usr/bin/env node\nconst fs = require('node:fs');\nfs.mkdirSync('reports/mutation', { recursive: true });\n" +
      `fs.writeFileSync('reports/mutation/mutation.json', ${JSON.stringify(JSON.stringify(report('Killed', 'Killed')))});\n` +
      "fs.writeFileSync('reports/stryker-incremental.json', String(Date.now() + Math.random()));\n";
    const repo = project({
      '.gitignore': 'node_modules\nreports\nhook-output.log\n',
      'pkg/test-gates.json': { gates: [gateEntry], candidates: [] },
      'pkg/src/age.ts': GATE_SOURCE,
      'pkg/src/age.spec.ts': SPEC_SOURCE,
      'pkg/src/paths.ts': "export const shared = '../../other/src';\n",
      'pkg/stryker.gates.config.mjs':
        "export default { incremental: true, testRunner: 'vitest' };\n",
      'pkg/node_modules/.bin/stryker': stryker,
      'other/src/money.ts': 'export const money = 1;\n',
    });
    fs.chmodSync(path.join(repo, 'pkg/node_modules/.bin/stryker'), 0o755);
    git(repo, 'init', '-q');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'first');
    const tree = `${repo}-tree`;
    git(repo, 'worktree', 'add', '-q', tree);
    fs.mkdirSync(path.join(tree, 'pkg/node_modules/.bin'), { recursive: true });
    fs.copyFileSync(
      path.join(repo, 'pkg/node_modules/.bin/stryker'),
      path.join(tree, 'pkg/node_modules/.bin/stryker')
    );
    fs.chmodSync(path.join(tree, 'pkg/node_modules/.bin/stryker'), 0o755);
    const log = path.join(tree, 'hook-output.log');
    fs.writeFileSync(
      path.join(repo, '.git/hooks/pre-commit'),
      `#!/bin/sh\necho "GIT_DIR=\${GIT_DIR:-unset}" >> "${log}"\n` +
        `${JSON.stringify(process.execPath)} ${JSON.stringify(cliPath)} mutation --affected --dir pkg >> "${log}" 2>&1\nexit 0\n`,
      { mode: 0o755 }
    );
    try {
      git(tree, 'commit', '-q', '--allow-empty', '-m', 'one');
      git(tree, 'commit', '-q', '--allow-empty', '-m', 'two');
      const output = fs.readFileSync(log, 'utf8');
      // git did hand the hook GIT_DIR
      expect(output).toMatch(/GIT_DIR=(?!unset)/);
      expect(output).not.toContain('points outside of what can be listed');
      expect(output).toContain(
        'test-gates mutation --affected: 1 of 1 gate(s) reused, 0 run again'
      );
    } finally {
      fs.rmSync(tree, { recursive: true, force: true });
    }
  });
});
