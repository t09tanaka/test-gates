import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  cleanup,
  gateEntry,
  project,
  report,
  repoRoot,
  testGates,
  validProject,
  write,
} from './helpers';

afterAll(cleanup);

const violationsOf = (stderr: string) =>
  stderr
    .split('\n')
    .filter((line) => line.startsWith('  - '))
    .map((line) => line.slice(4));

describe('test-gates (general)', () => {
  it('prints the version of package.json', () => {
    const { version } = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    expect(testGates(['--version'])).toEqual({ status: 0, stdout: `${version}\n`, stderr: '' });
  });

  it('prints help that lists every command', () => {
    const result = testGates(['--help']);
    expect(result.status).toBe(0);
    for (const command of ['check', 'mutation', 'mutation-result', 'selfcheck', 'lcov']) {
      expect(result.stdout).toMatch(new RegExp(`^  ${command}\\b`, 'm'));
    }
  });

  it.each([
    [[], 'test-gates: no command given'],
    [['frobnicate'], 'test-gates: unknown command: frobnicate'],
    [['check', '--bogus'], 'test-gates: unknown argument for check: --bogus'],
  ])('exits 2 with usage for %j', (args, message) => {
    const result = testGates(args);
    expect(result.status).toBe(2);
    expect(result.stderr.split('\n')[0]).toBe(message);
    expect(result.stderr).toContain('Usage: test-gates <command>');
  });

  it('exits 2 when test-gates.json is missing', () => {
    const dir = project({ 'README.md': 'x' });
    const result = testGates(['check', '--dir', dir]);
    expect(result).toEqual({
      status: 2,
      stdout: '',
      stderr: `test-gates: test-gates.json not found in ${dir}\n`,
    });
  });

  it('exits 2 when test-gates.json is not valid JSON', () => {
    const dir = project({ 'test-gates.json': '{ "gates": [' });
    const result = testGates(['check'], { cwd: dir });
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/^test-gates: test-gates\.json is not valid JSON: /);
  });

  it.each(['check', 'mutation-result', 'selfcheck', 'lcov', 'mutation'])(
    'exits 2 from %s when a setting is misspelled',
    (command) => {
      const dir = validProject({}, { settings: { specSuffix: '.spec.ts' } });
      const result = testGates([command, '--dir', dir]);
      expect(result.status).toBe(2);
      expect(result.stderr).toBe(
        'test-gates: test-gates.json: settings: unknown key "specSuffix"\n'
      );
    }
  );
});

describe('test-gates check', () => {
  it('passes a valid project', () => {
    const dir = validProject(
      { 'src/admin.guard.ts': '@Injectable()\nexport class AdminGuard {}\n' },
      { candidates: [{ path: 'src/admin.guard.ts', decides: 'admin role', blocker: 'decorators' }] }
    );
    expect(testGates(['check', '--dir', dir])).toEqual({
      status: 0,
      stdout: 'test-gates check: OK (1 gate(s), 1 candidate(s))\n',
      stderr: '',
    });
  });

  it('uses the current directory by default', () => {
    expect(testGates(['check'], { cwd: validProject() }).status).toBe(0);
  });

  it('reports every violation at once, as file:line: reason, and exits 1', () => {
    const dir = project({
      'test-gates.json': {
        gates: [
          gateEntry,
          { path: 'src/guard.ts', decides: 'd', impact: 'i' },
          { path: 'src/nospec.ts', decides: 'd', impact: 'i' },
          { path: 'src/missing.ts', decides: 'd', impact: 'i' },
          { path: 'src/View.tsx', decides: 'd', impact: 'i' },
          { path: 'src/age.spec.ts', decides: 'd', impact: 'i' },
          { path: '../outside.ts', decides: 'd', impact: 'i' },
          { path: 'src/style.css', decides: 'd', impact: 'i' },
          { path: 'src/noimpact.ts', decides: 'd' },
          gateEntry,
        ],
        candidates: [
          { path: 'src/guard.ts', decides: 'd', blocker: 'b' },
          { path: 'src/gone.ts', decides: 'd', blocker: 'b' },
        ],
      },
      'src/age.ts':
        'export const isAdult = (age: number) => age >= 18; // Stryker disable next-line all\n',
      'src/age.spec.ts': [
        "import { isAdult } from './age';",
        "jest.mock('./age');",
        '/* istanbul ignore next */',
        "it.skip('x', () => {});",
        "describe.only('y', () => {});",
        "xit('z', () => {});",
        "it.todo('later');",
      ].join('\n'),
      'src/guard.ts': [
        "import { Injectable } from '@nestjs/common';",
        "import { PrismaClient } from '@prisma/client';",
        '',
        '@Injectable()',
        'export class Guard {',
        '  /* c8 ignore next */',
        '}',
      ].join('\n'),
      'src/guard.spec.ts': "it('x', () => {});\n",
      'src/nospec.ts': 'export const a = 1;\n',
      'src/noimpact.ts': 'export const a = 1;\n',
      'src/noimpact.test.ts': "it('x', () => {});\n",
      'src/View.tsx': 'export const View = () => null;\n',
      'src/View.spec.tsx': "it('x', () => {});\n",
      'src/style.css': '',
    });
    const result = testGates(['check', '--dir', dir]);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr.split('\n')[0]).toBe('test-gates check: 21 violation(s)');
    expect(violationsOf(result.stderr)).toEqual([
      'test-gates.json: src/noimpact.ts: "impact" is missing in gates',
      'test-gates.json: src/age.ts: listed twice in gates',
      'test-gates.json: src/guard.ts: listed in both gates and candidates',
      'src/age.ts:1: Stryker comment (disable / restore). Allow an equivalent mutant in test-gates.json (equivalentMutants) instead',
      'src/age.spec.ts:2: mocks the module under test ("./age")',
      'src/age.spec.ts:3: coverage ignore directive',
      'src/age.spec.ts:4: .skip / .only / .todo (a skipped or focused test)',
      'src/age.spec.ts:5: .skip / .only / .todo (a skipped or focused test)',
      'src/age.spec.ts:6: xit / xtest / xdescribe / fit / fdescribe (a skipped or focused test)',
      'src/age.spec.ts:7: .skip / .only / .todo (a skipped or focused test)',
      'src/guard.ts:1: runtime import of "@nestjs/common" (NestJS runtime (DI, decorators))',
      'src/guard.ts:2: runtime use of PrismaClient from "@prisma/client" (connects to the database)',
      'src/guard.ts:4: decorator found (not a pure module). Move the file to candidates',
      'src/guard.ts:6: coverage ignore directive',
      'src/nospec.ts: spec not found (looked for src/nospec.spec.ts, src/nospec.test.ts; the check is case-sensitive)',
      'src/missing.ts: file not found (the check is case-sensitive)',
      'src/View.tsx: a gate must be one of .ts / .mts / .cts / .js / .mjs / .cjs (settings.gateExtensions)',
      'src/age.spec.ts: a spec cannot be a gate',
      'test-gates.json: ../outside.ts: write the path relative to the subproject, with "/" and without ".."',
      'src/style.css: a gate must be one of .ts / .mts / .cts / .js / .mjs / .cjs (settings.gateExtensions)',
      'test-gates.json: src/gone.ts: candidate not found. Remove it, or fix the path',
    ]);
  });

  it('distinguishes upper and lower case in the gate and the spec', () => {
    // On macOS / Windows these files "exist" under either spelling; on Linux they do not.
    const dir = project({
      'test-gates.json': {
        gates: [
          { path: 'src/Plan.ts', decides: 'd', impact: 'i' },
          { path: 'src/rate.ts', decides: 'd', impact: 'i' },
          { path: 'SRC/tax.ts', decides: 'd', impact: 'i' },
        ],
        candidates: [],
      },
      'src/plan.ts': 'export const a = 1;\n',
      'src/plan.spec.ts': "it('x', () => {});\n",
      'src/rate.ts': 'export const a = 1;\n',
      'src/Rate.spec.ts': "it('x', () => {});\n",
      'src/tax.ts': 'export const a = 1;\n',
      'src/tax.spec.ts': "it('x', () => {});\n",
    });
    const result = testGates(['check', '--dir', dir]);
    expect(result.status).toBe(1);
    expect(violationsOf(result.stderr)).toEqual([
      'src/Plan.ts: file not found (the check is case-sensitive)',
      'src/rate.ts: spec not found (looked for src/rate.spec.ts, src/rate.test.ts; the check is case-sensitive)',
      'SRC/tax.ts: file not found (the check is case-sensitive)',
    ]);
  });

  it('rejects a gate with both a .spec and a .test file', () => {
    const dir = validProject({ 'src/age.test.ts': "it('x', () => {});\n" });
    const result = testGates(['check', '--dir', dir]);
    expect(result.status).toBe(1);
    expect(violationsOf(result.stderr)).toEqual([
      'src/age.ts: more than one spec (src/age.spec.ts, src/age.test.ts). Keep one, or narrow settings.spec.suffixes',
    ]);
    write(dir, {
      'test-gates.json': {
        gates: [gateEntry],
        candidates: [],
        settings: { spec: { suffixes: ['.spec.ts'] } },
      },
    });
    expect(testGates(['check', '--dir', dir]).status).toBe(0);
  });

  it('finds a spec in another directory through settings.spec.rewrite', () => {
    const dir = project({
      'test-gates.json': {
        gates: [{ path: 'app/utils/plan.ts', decides: 'd', impact: 'i' }],
        candidates: [],
        settings: {
          spec: { suffixes: ['.spec.ts'], rewrite: [{ from: '^app/', to: 'tests/' }] },
          importAliases: [{ prefix: '~/', target: 'app/' }],
        },
      },
      'app/utils/plan.ts': 'export const a = 1;\n',
      'tests/utils/plan.spec.ts': "vi.mock('~/utils/plan');\nit('x', () => {});\n",
    });
    const result = testGates(['check', '--dir', dir]);
    expect(violationsOf(result.stderr)).toEqual([
      'tests/utils/plan.spec.ts:1: mocks the module under test ("~/utils/plan")',
    ]);
  });

  it('reports a broken allow list', () => {
    const dir = validProject(
      {},
      {
        gates: [
          {
            ...gateEntry,
            equivalentMutants: [
              { mutator: 'EqualityOperator', original: 'age >= 18', replacement: 'age > 18' },
              { mutator: 'X', original: 'a', replacement: 'b', reason: 'r', occurrence: 0 },
            ],
          },
        ],
      }
    );
    const result = testGates(['check', '--dir', dir]);
    expect(result.status).toBe(1);
    expect(violationsOf(result.stderr)).toEqual([
      'test-gates.json: src/age.ts: equivalentMutants[0]: "reason" is missing (say why the mutant cannot be observed)',
      'test-gates.json: src/age.ts: equivalentMutants[1]: "occurrence" must be an integer >= 1',
    ]);
  });

  it('reports an empty gate list', () => {
    const dir = project({ 'test-gates.json': { gates: [], candidates: [] } });
    const result = testGates(['check', '--dir', dir]);
    expect(result.status).toBe(1);
    expect(violationsOf(result.stderr)).toEqual([
      'test-gates.json: gates is empty. A project with nothing to gate should not have this file',
    ]);
  });

  it('accepts a directory as a candidate, but not a missing one', () => {
    const dir = validProject(
      { 'src/services/a.ts': '' },
      {
        candidates: [
          { path: 'src/services', decides: 'd', blocker: 'b' },
          { path: 'src/Services', decides: 'd', blocker: 'b' },
        ],
      }
    );
    expect(violationsOf(testGates(['check', '--dir', dir]).stderr)).toEqual([
      'test-gates.json: src/Services: candidate not found. Remove it, or fix the path',
    ]);
  });

  it('rejects a Stryker config that takes mutants out of the evaluation', () => {
    const dir = validProject({
      'stryker.gates.config.mjs':
        "export default {\n  testRunner: 'jest',\n  mutator: { excludedMutations: ['StringLiteral'] },\n};\n",
    });
    const result = testGates(['check', '--dir', dir]);
    expect(result.status).toBe(1);
    expect(violationsOf(result.stderr)).toEqual([
      'stryker.gates.config.mjs:3: excludedMutations takes mutants out of the evaluation. Allow equivalent mutants one by one in test-gates.json instead',
    ]);
  });

  it('reports a configured Stryker config that does not exist', () => {
    const dir = validProject({}, { settings: { stryker: { configFile: 'stryker.conf.mjs' } } });
    expect(violationsOf(testGates(['check', '--dir', dir]).stderr)).toEqual([
      'stryker.conf.mjs: Stryker config not found',
    ]);
  });

  it('applies project rules from settings', () => {
    const dir = project({
      'test-gates.json': {
        gates: [{ path: 'src/user.service.ts', decides: 'd', impact: 'i' }],
        candidates: [],
        settings: {
          impureImports: {
            add: [{ pattern: '(^|/)repository(/|$)', reason: 'DB layer' }],
            allow: ['^express$'],
          },
          impurePaths: { add: [{ pattern: '\\.service\\.ts$', reason: 'NestJS class file' }] },
          forbiddenSource: { add: [{ pattern: 'process\\.env', reason: 'reads the environment' }] },
        },
      },
      'src/user.service.ts': [
        "import { Response } from 'express';",
        "import { find } from './repository/user';",
        'export const region = process.env.REGION;',
      ].join('\n'),
      'src/user.service.spec.ts': "it('x', () => {});\n",
    });
    expect(violationsOf(testGates(['check', '--dir', dir]).stderr)).toEqual([
      'src/user.service.ts: cannot be a gate (NestJS class file). Move it to candidates',
      'src/user.service.ts:2: runtime import of "./repository/user" (DB layer)',
      'src/user.service.ts:3: reads the environment',
    ]);
  });
});

describe('test-gates mutation-result', () => {
  const allowance = {
    mutator: 'EqualityOperator',
    original: 'age >= 18',
    replacement: 'age > 18',
    reason: 'documented reason',
  };

  it('passes when every mutant is detected, and prints the real numbers', () => {
    const dir = validProject({ 'reports/mutation/mutation.json': report('Killed', 'Timeout') });
    expect(testGates(['mutation-result', '--dir', dir])).toEqual({
      status: 0,
      stdout:
        'test-gates mutation: OK (mutants 2 / detected 2 (timeout 1) / allowed equivalent 0 / not evaluable 0 / unallowed survivors 0)\n',
      stderr: '',
    });
  });

  it('fails on survivors and prints each with a ready-to-paste allowance', () => {
    const dir = validProject({
      'reports/mutation/mutation.json': report('Survived', 'NoCoverage'),
    });
    const result = testGates(['mutation-result', '--dir', dir]);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    const lines = result.stderr.split('\n');
    expect(lines[0]).toBe('test-gates mutation: 2 surviving mutant(s) not in the allow list');
    expect(violationsOf(result.stderr)).toEqual([
      'src/age.ts:1:41 / EqualityOperator / age >= 18 → age > 18 / occurrence 1 of 2 (Survived)',
      'src/age.ts:2:42 / EqualityOperator / age >= 18 → age > 18 / occurrence 2 of 2 (NoCoverage)',
    ]);
    const snippets = lines.filter((line) => line.startsWith('    {'));
    expect(snippets.map((line) => JSON.parse(line.trim().replace(/,$/, '')))).toEqual([
      {
        mutator: 'EqualityOperator',
        original: 'age >= 18',
        replacement: 'age > 18',
        occurrence: 1,
        reason: '',
      },
      {
        mutator: 'EqualityOperator',
        original: 'age >= 18',
        replacement: 'age > 18',
        occurrence: 2,
        reason: '',
      },
    ]);
    expect(lines.at(-2)).toBe(
      'test-gates mutation: FAILED (mutants 2 / detected 0 (timeout 0) / allowed equivalent 0 / not evaluable 0 / unallowed survivors 2)'
    );
  });

  it('passes survivors that the allow list covers one by one', () => {
    const dir = validProject(
      { 'reports/mutation/mutation.json': report('Survived', 'Killed') },
      { gates: [{ ...gateEntry, equivalentMutants: [{ ...allowance, occurrence: 1 }] }] }
    );
    const result = testGates(['mutation-result', '--dir', dir]);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(
      'test-gates mutation: OK (mutants 2 / detected 1 (timeout 0) / allowed equivalent 1 / not evaluable 0 / unallowed survivors 0)\n'
    );
  });

  it('fails on an allowance without occurrence when the mutant exists twice', () => {
    const dir = validProject(
      { 'reports/mutation/mutation.json': report('Survived', 'Killed') },
      { gates: [{ ...gateEntry, equivalentMutants: [allowance] }] }
    );
    const result = testGates(['mutation-result', '--dir', dir]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'matches 2 mutants in the file. Add "occurrence" (1-based) to pick one'
    );
  });

  it('fails on a stale allowance', () => {
    const dir = validProject(
      { 'reports/mutation/mutation.json': report('Killed', 'Killed') },
      { gates: [{ ...gateEntry, equivalentMutants: [{ ...allowance, occurrence: 2 }] }] }
    );
    const result = testGates(['mutation-result', '--dir', dir]);
    expect(result.status).toBe(1);
    expect(violationsOf(result.stderr)).toEqual([
      'test-gates.json: src/age.ts: equivalentMutants[0] (EqualityOperator / age >= 18 → age > 18 / occurrence 2): stale allowance (the mutant is now Killed). Remove it',
    ]);
  });

  it('fails when the report is missing', () => {
    const result = testGates(['mutation-result', '--dir', validProject()]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(
      /^test-gates mutation: cannot read the Stryker JSON report reports\/mutation\/mutation\.json \(/
    );
  });

  it('fails when the report was made from an older version of the gate', () => {
    const dir = validProject({ 'reports/mutation/mutation.json': report('Killed', 'Killed') });
    fs.appendFileSync(path.join(dir, 'src/age.ts'), 'export const added = 1;\n');
    const result = testGates(['mutation-result', '--dir', dir]);
    expect(result.status).toBe(1);
    expect(violationsOf(result.stderr)[0]).toBe(
      'src/age.ts: the report was made from a different version of this file. Run Stryker again'
    );
  });

  it('reads the report from settings.stryker.reportFile, and --report overrides it', () => {
    const dir = validProject(
      {
        'out/gates.json': report('Killed', 'Killed'),
        'other.json': report('Survived', 'Killed'),
      },
      { settings: { stryker: { reportFile: 'out/gates.json' } } }
    );
    expect(testGates(['mutation-result', '--dir', dir]).status).toBe(0);
    expect(testGates(['mutation-result', '--dir', dir, '--report', 'other.json']).status).toBe(1);
  });
});

describe('test-gates mutation', () => {
  // A stand-in for node_modules/.bin/stryker: records its arguments, then behaves as told.
  const fakeStryker = (body: string) =>
    `#!/usr/bin/env node\nconst fs = require('node:fs');\nfs.writeFileSync('stryker-args.json', JSON.stringify(process.argv.slice(2)));\n${body}\n`;
  const writeReport = (first: string, second: string) =>
    `fs.mkdirSync('reports/mutation', { recursive: true });\nfs.writeFileSync('reports/mutation/mutation.json', ${JSON.stringify(JSON.stringify(report(first, second)))});`;

  function withStryker(body: string, extra: Record<string, string | object> = {}): string {
    const dir = validProject({
      'stryker.gates.config.mjs': 'export default {};\n',
      'node_modules/.bin/stryker': fakeStryker(body),
      ...extra,
    });
    fs.chmodSync(path.join(dir, 'node_modules/.bin/stryker'), 0o755);
    return dir;
  }
  const strykerArgs = (dir: string) =>
    JSON.parse(fs.readFileSync(path.join(dir, 'stryker-args.json'), 'utf8'));

  it('runs the local Stryker with the gates config, then judges the report', () => {
    const dir = withStryker(writeReport('Killed', 'Killed'));
    const result = testGates(['mutation', '--dir', dir]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      'test-gates mutation: OK (mutants 2 / detected 2 (timeout 0) /'
    );
    expect(strykerArgs(dir)).toEqual(['run', 'stryker.gates.config.mjs']);
  });

  it('hands extra arguments to Stryker only, as npm passes them', () => {
    // `npm run test:gates:mutation -- --force --concurrency 1` arrives without the "--".
    const dir = withStryker(writeReport('Killed', 'Killed'));
    expect(testGates(['mutation', '--force', '--concurrency', '1'], { cwd: dir }).status).toBe(0);
    expect(strykerArgs(dir)).toEqual([
      'run',
      'stryker.gates.config.mjs',
      '--force',
      '--concurrency',
      '1',
    ]);
    expect(testGates(['mutation', '--', '--force'], { cwd: dir }).status).toBe(0);
    expect(strykerArgs(dir)).toEqual(['run', 'stryker.gates.config.mjs', '--force']);
  });

  it('fails when the judged report has a survivor', () => {
    const dir = withStryker(writeReport('Survived', 'Killed'));
    const result = testGates(['mutation', '--dir', dir]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('1 surviving mutant(s) not in the allow list');
  });

  it('exits 1 without judging when Stryker fails', () => {
    const dir = withStryker(`${writeReport('Killed', 'Killed')}\nprocess.exit(3);`);
    const result = testGates(['mutation', '--dir', dir]);
    expect(result.status).toBe(1);
    expect(result.stderr).toBe(
      'test-gates mutation: Stryker failed (exit 3). The result was not judged\n'
    );
    expect(result.stdout).not.toContain('OK');
  });

  it('does not judge a report left over from an earlier run', () => {
    const dir = withStryker('', { 'reports/mutation/mutation.json': report('Killed', 'Killed') });
    const result = testGates(['mutation', '--dir', dir]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('cannot read the Stryker JSON report');
  });

  it('uses settings.stryker.configFile', () => {
    const dir = withStryker(writeReport('Killed', 'Killed'), {
      'conf/stryker.mjs': 'export default {};\n',
      'test-gates.json': {
        gates: [gateEntry],
        candidates: [],
        settings: { stryker: { configFile: 'conf/stryker.mjs' } },
      },
    });
    expect(testGates(['mutation', '--dir', dir]).status).toBe(0);
    expect(strykerArgs(dir)).toEqual(['run', 'conf/stryker.mjs']);
  });

  it('exits 2 when there is no Stryker config', () => {
    const result = testGates(['mutation', '--dir', validProject()]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('no Stryker config found');
  });

  it('exits 2 when Stryker is not installed', () => {
    const dir = validProject({ 'stryker.gates.config.mjs': 'export default {};\n' });
    const result = testGates(['mutation', '--dir', dir]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('stryker is not installed in this project');
  });
});

describe('test-gates selfcheck', () => {
  // Stand-ins for the gate command. They append the excluded spec to a log.
  const HONEST = [
    "const fs = require('node:fs');",
    'const excluded = process.env.TEST_GATES_EXCLUDE_SPEC;',
    "fs.appendFileSync('runs.log', `${excluded}\\n`);",
    "const { gates } = JSON.parse(fs.readFileSync('test-gates.json', 'utf8'));",
    'for (const gate of gates) {',
    "  if (gate.path.replace(/\\.ts$/, '.spec.ts') === excluded) {",
    '    console.error(`Jest: "${process.cwd()}/${gate.path}" coverage threshold for lines (100%) not met: 0%`);',
    '    process.exit(1);',
    '  }',
    '}',
  ].join('\n');
  const DEAF = "require('node:fs').appendFileSync('runs.log', 'run\\n');\n";
  const BROKEN = "console.error('Error: Cannot find module ts-jest'); process.exit(1);\n";

  const twoGates = (gateScript: string, settings: object = {}) =>
    validProject(
      {
        'gate.cjs': gateScript,
        'src/rate.ts': 'export const rate = 1;\n',
        'src/rate.spec.ts': "it('x', () => {});\n",
      },
      {
        gates: [gateEntry, { path: 'src/rate.ts', decides: 'd', impact: 'i' }],
        settings: { gateCommand: ['node', 'gate.cjs'], ...settings },
      }
    );
  const runs = (dir: string) =>
    fs.readFileSync(path.join(dir, 'runs.log'), 'utf8').trim().split('\n');

  it('leaves out the spec of every gate in turn and passes when each run fails on its threshold', () => {
    const dir = twoGates(HONEST);
    expect(testGates(['selfcheck', '--dir', dir])).toEqual({
      status: 0,
      stdout:
        '  ✓ without src/age.spec.ts the gate fails (exit 1)\n' +
        '  ✓ without src/rate.spec.ts the gate fails (exit 1)\n' +
        'test-gates selfcheck: OK (2 negative control(s) failed as they should)\n',
      stderr: '',
    });
    expect(runs(dir)).toEqual(['src/age.spec.ts', 'src/rate.spec.ts']);
  });

  it('checks only the first gate with --first or settings.selfcheck.mode', () => {
    const dir = twoGates(HONEST);
    expect(testGates(['selfcheck', '--first', '--dir', dir]).status).toBe(0);
    expect(runs(dir)).toEqual(['src/age.spec.ts']);

    const configured = twoGates(HONEST, { selfcheck: { mode: 'first' } });
    expect(testGates(['selfcheck', '--dir', configured]).status).toBe(0);
    expect(runs(configured)).toEqual(['src/age.spec.ts']);
    expect(testGates(['selfcheck', '--all', '--dir', configured]).status).toBe(0);
    expect(runs(configured)).toHaveLength(3);
  });

  it('fails when the gate stays green without a spec', () => {
    const dir = twoGates(DEAF);
    const result = testGates(['selfcheck', '--dir', dir]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      '  ✗ src/age.ts: the gate passed although the spec of src/age.ts was left out.'
    );
    expect(result.stderr).toContain('test-gates selfcheck: FAILED (2 of 2 negative control(s))');
    expect(runs(dir)).toHaveLength(2);
  });

  it('fails when the gate fails for a reason other than the threshold, and shows the output', () => {
    const result = testGates(['selfcheck', '--dir', twoGates(BROKEN)]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'the gate failed (exit 1) but not on the coverage threshold of src/age.ts'
    );
    expect(result.stderr).toContain('      Error: Cannot find module ts-jest');
  });

  it('fails when the gate command cannot be started', () => {
    const dir = twoGates(HONEST, { gateCommand: ['test-gates-no-such-command'] });
    const result = testGates(['selfcheck', '--first', '--dir', dir]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('cannot start "test-gates-no-such-command"');
  });

  it('runs the command given after "--" instead of the configured one', () => {
    const dir = twoGates(DEAF);
    write(dir, { 'honest.cjs': HONEST });
    expect(testGates(['selfcheck', '--dir', dir, '--', 'node', 'honest.cjs']).status).toBe(0);
  });

  it('prefers node_modules/.bin of the project for the gate command', () => {
    const dir = twoGates(DEAF, { gateCommand: ['jest', '--config', 'jest.gates.config.js'] });
    write(dir, { 'node_modules/.bin/jest': `#!/usr/bin/env node\n${HONEST}\n` });
    fs.chmodSync(path.join(dir, 'node_modules/.bin/jest'), 0o755);
    expect(testGates(['selfcheck', '--dir', dir]).status).toBe(0);
  });

  it.each([
    ['jest.gates.config.js', ['--config', 'jest.gates.config.js']],
    ['vitest.gates.config.ts', ['run', '--config', 'vitest.gates.config.ts']],
  ])('derives the gate command from %s', (config, expectedArgs) => {
    const runner = config.startsWith('jest') ? 'jest' : 'vitest';
    const dir = validProject({
      [config]: '',
      [`node_modules/.bin/${runner}`]:
        "#!/usr/bin/env node\nrequire('node:fs').writeFileSync('args.json', JSON.stringify(process.argv.slice(2)));\n" +
        "console.error('ERROR: Coverage for lines (0%) does not meet global threshold (100%) for src/age.ts');\nprocess.exit(1);\n",
    });
    fs.chmodSync(path.join(dir, `node_modules/.bin/${runner}`), 0o755);
    expect(testGates(['selfcheck', '--dir', dir]).status).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'args.json'), 'utf8'))).toEqual(expectedArgs);
  });

  it('exits 2 when no gate command can be derived', () => {
    const result = testGates(['selfcheck', '--dir', validProject()]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('no gate config found');
  });

  it('exits 2 when both a Jest and a Vitest gate config exist', () => {
    const dir = validProject({ 'jest.gates.config.js': '', 'vitest.gates.config.ts': '' });
    const result = testGates(['selfcheck', '--dir', dir]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('both jest.gates.config.js and vitest.gates.config.ts exist');
  });

  it('fails when a gate has no spec to leave out', () => {
    const dir = twoGates(HONEST);
    fs.rmSync(path.join(dir, 'src/rate.spec.ts'));
    const result = testGates(['selfcheck', '--dir', dir]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      '  ✗ src/rate.ts: no single spec to leave out. Run "test-gates check"'
    );
  });

  it('fails when the manifest has problems', () => {
    const dir = validProject({ 'gate.cjs': HONEST }, { gates: [{ path: 'src/age.ts' }] });
    const result = testGates(['selfcheck', '--dir', dir, '--', 'node', 'gate.cjs']);
    expect(result.status).toBe(1);
    expect(result.stderr).toBe(
      'test-gates selfcheck: test-gates.json has problems. Run "test-gates check" first\n'
    );
  });
});

describe('test-gates lcov', () => {
  const dartProject = (lcov: string, settings: object = {}) =>
    project({
      'test-gates.json': {
        gates: [
          { path: 'lib/models/coupon.dart', decides: 'discount', impact: 'payment rejected' },
          { path: 'lib/utils/number_utils.dart', decides: 'rounding', impact: 'wrong amounts' },
        ],
        candidates: [],
        ...settings,
      },
      'lib/models/coupon.dart': 'int f() => 1;\n',
      'lib/utils/number_utils.dart': 'int g() => 1;\n',
      'coverage/lcov.info': lcov,
    });
  const FULL = [
    'SF:lib/models/coupon.dart',
    'DA:1,3',
    'DA:2,1',
    'LF:2',
    'LH:2',
    'end_of_record',
    'SF:lib/utils/number_utils.dart',
    'DA:1,1',
    'LF:1',
    'LH:1',
    'end_of_record',
    'SF:lib/l10n/app.g.dart',
    'DA:1,0',
    'LF:1',
    'LH:0',
    'end_of_record',
    '',
  ].join('\n');

  it('passes when every gate has all its lines hit', () => {
    const dir = dartProject(FULL);
    expect(testGates(['lcov', '--file', 'coverage/lcov.info', '--dir', dir])).toEqual({
      status: 0,
      stdout:
        'reference: overall line coverage 75.00% (3/4, not gated)\n' +
        '  ✓ lib/models/coupon.dart: 2/2 lines\n' +
        '  ✓ lib/utils/number_utils.dart: 1/1 lines\n' +
        'test-gates lcov: OK (2 gate(s) at 100% line coverage)\n',
      stderr: '',
    });
  });

  it('fails on an uncovered line, a missing record and a missing file', () => {
    const dir = dartProject(
      FULL.replace('DA:2,1', 'DA:2,0').replace(
        'SF:lib/utils/number_utils.dart',
        'SF:lib/utils/other.dart'
      )
    );
    fs.rmSync(path.join(dir, 'lib/utils/number_utils.dart'));
    write(dir, {
      'test-gates.json': {
        gates: [
          { path: 'lib/models/coupon.dart', decides: 'd', impact: 'i' },
          { path: 'lib/utils/number_utils.dart', decides: 'd', impact: 'i' },
          { path: 'lib/models/cart.dart', decides: 'd', impact: 'i' },
        ],
        candidates: [],
      },
      'lib/models/cart.dart': '',
    });
    const result = testGates(['lcov', '--file', 'coverage/lcov.info', '--dir', dir]);
    expect(result.status).toBe(1);
    expect(violationsOf(result.stderr)).toEqual([
      'lib/utils/number_utils.dart: file not found (the check is case-sensitive). Update test-gates.json if it moved',
      'lib/models/coupon.dart:2: 1/2 lines covered (uncovered: 2)',
      'lib/models/cart.dart: no record in the lcov file',
    ]);
  });

  it('understands absolute SF paths inside the project', () => {
    const base = dartProject('');
    write(base, { 'coverage/lcov.info': FULL.replace(/SF:lib\//g, `SF:${base}/lib/`) });
    expect(testGates(['lcov', '--file', 'coverage/lcov.info'], { cwd: base }).status).toBe(0);
  });

  it('takes the file and the summary excludes from settings', () => {
    const dir = dartProject(FULL, {
      settings: {
        gateExtensions: ['.dart'],
        lcov: { file: 'coverage/lcov.info', summaryExclude: ['\\.g\\.dart$'] },
      },
    });
    const result = testGates(['lcov', '--dir', dir]);
    expect(result.status).toBe(0);
    expect(result.stdout.split('\n')[0]).toBe(
      'reference: overall line coverage 100.00% (3/3, not gated)'
    );
  });

  it('exits 1 when the lcov file cannot be read', () => {
    const result = testGates(['lcov', '--file', 'nope.info', '--dir', dartProject(FULL)]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/^test-gates lcov: cannot read nope\.info \(/);
  });

  it('exits 2 when no lcov file is named', () => {
    const result = testGates(['lcov', '--dir', dartProject(FULL)]);
    expect(result.status).toBe(2);
    expect(result.stderr).toBe(
      'test-gates: no lcov file given. Pass --file <lcov.info> or set settings.lcov.file\n'
    );
  });
});
