import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  cleanup,
  GATE_SOURCE,
  gateEntry,
  project,
  report,
  SPEC_SOURCE,
  testGates,
  write,
} from './helpers';

afterAll(cleanup);

// A stand-in for node_modules/.bin/stryker. It records its arguments and, like Stryker in
// incremental mode, writes a report and an incremental file. With a file named `stryker-fails`
// in the subproject it writes the incremental file and then fails, as an interrupted run does.
const FAKE_STRYKER = `#!/usr/bin/env node
const fs = require('node:fs');
fs.mkdirSync('reports/mutation', { recursive: true });
fs.writeFileSync('reports/mutation/stryker-args.json', JSON.stringify(process.argv.slice(2)));
fs.writeFileSync('reports/stryker-incremental.json', JSON.stringify({ written: process.hrtime.bigint().toString() }));
if (fs.existsSync('stryker-fails')) process.exit(1);
fs.writeFileSync('reports/mutation/mutation.json', ${JSON.stringify(JSON.stringify(report('Killed', 'Killed')))});
`;

const IGNORE = 'node_modules\nreports\n.stryker-tmp\nscratch.log\n';
const INCREMENTAL = 'reports/stryker-incremental.json';
const RECORD = `${INCREMENTAL}.test-gates.json`;
const NOTE =
  'test-gates mutation: running every mutant again (--force), the results of the last run are not reused: ';

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

/** Files of a subproject with one gate, a file its spec imports, and the stand-in for Stryker. */
const subproject = (prefix = ''): Record<string, string | object> => ({
  [`${prefix}test-gates.json`]: { gates: [gateEntry], candidates: [] },
  [`${prefix}package.json`]: { name: 'fixture', private: true },
  [`${prefix}src/age.ts`]: GATE_SOURCE,
  [`${prefix}src/age.spec.ts`]: "import { expectTrue } from './expect-true';\n" + SPEC_SOURCE,
  [`${prefix}src/expect-true.ts`]:
    'export const expectTrue = (value: boolean) => expect(value).toBe(true);\n',
  [`${prefix}stryker.gates.config.mjs`]: 'export default { incremental: true };\n',
  [`${prefix}node_modules/.bin/stryker`]: FAKE_STRYKER,
});

function create(files: Record<string, string | object>, kind: 'git' | 'walk', sub = ''): string {
  const root = project({ '.gitignore': IGNORE, ...files });
  fs.chmodSync(path.join(root, sub, 'node_modules/.bin/stryker'), 0o755);
  if (kind === 'git') {
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'first');
  }
  return root;
}

interface Run {
  status: number | null;
  /** Whether Stryker was told to run every mutant again. */
  forced: boolean;
  /** Why, as printed; null when nothing was printed. */
  reason: string | null;
  args: string[];
}

function mutation(dir: string, ...extra: string[]): Run {
  const result = testGates(['mutation', '--dir', dir, ...extra]);
  const args = JSON.parse(
    fs.readFileSync(path.join(dir, 'reports/mutation/stryker-args.json'), 'utf8')
  ) as string[];
  const note = result.stdout.split('\n').find((line) => line.startsWith(NOTE));
  return {
    status: result.status,
    forced: args.includes('--force'),
    reason: note === undefined ? null : note.slice(NOTE.length),
    args,
  };
}

const REUSED: Run = {
  status: 0,
  forced: false,
  reason: null,
  args: ['run', 'stryker.gates.config.mjs'],
};
const forcedBy = (reason: string): Run => ({
  status: 0,
  forced: true,
  reason,
  args: ['run', 'stryker.gates.config.mjs', '--force'],
});
// A path that goes up `levels` directories. Put together here, because written out in this
// file it would be a path that leads out of this repository, and the guard reads this file too.
const up = (levels: number) => Array.from({ length: levels }, () => '..').join('/');
const CHANGED = 'changed since the last run, and neither a gate nor its spec: ';

describe.each(['git', 'walk'] as const)(
  'test-gates mutation, reuse of the last run (%s)',
  (kind) => {
    const fresh = (extra: Record<string, string | object> = {}) =>
      create({ ...subproject(), ...extra }, kind);

    it('lets the first run and a run after no change go to Stryker as they are', () => {
      const dir = fresh();
      expect(mutation(dir)).toEqual(REUSED);
      expect(fs.existsSync(path.join(dir, RECORD))).toBe(true);
      expect(mutation(dir)).toEqual(REUSED);
      expect(mutation(dir)).toEqual(REUSED);
    });

    it('still reuses when only a gate or only its spec changed: Stryker compares those itself', () => {
      const dir = fresh();
      mutation(dir);
      write(dir, { 'src/age.ts': `${GATE_SOURCE}// a comment\n` });
      expect(mutation(dir)).toMatchObject({ forced: false, reason: null });
      write(dir, { 'src/age.ts': GATE_SOURCE });
      write(dir, { 'src/age.spec.ts': `${SPEC_SOURCE}// a comment\n` });
      expect(mutation(dir)).toEqual(REUSED);
    });

    it('runs every mutant again when a file that a spec imports changed, and says which', () => {
      const dir = fresh();
      mutation(dir);
      write(dir, {
        'src/expect-true.ts':
          'export const expectTrue = (value: boolean) => expect(value).toBeDefined();\n',
      });
      expect(mutation(dir)).toEqual(forcedBy(`${CHANGED}src/expect-true.ts`));
      // The run that followed the change is recorded: the next one reuses again.
      expect(mutation(dir)).toEqual(REUSED);
    });

    it.each([
      [
        'a new file',
        (dir: string) => write(dir, { 'src/new-helper.ts': 'export {};\n' }),
        'src/new-helper.ts',
      ],
      [
        'a deleted file',
        (dir: string) => fs.rmSync(path.join(dir, 'src/expect-true.ts')),
        'src/expect-true.ts',
      ],
      [
        'test-gates.json',
        (dir: string) =>
          write(dir, {
            'test-gates.json': { gates: [{ ...gateEntry, decides: 'x' }], candidates: [] },
          }),
        'test-gates.json',
      ],
      [
        'the Stryker config',
        (dir: string) =>
          write(dir, {
            'stryker.gates.config.mjs': 'export default { incremental: true, timeoutMS: 9000 };\n',
          }),
        'stryker.gates.config.mjs',
      ],
      [
        'the config of the test runner',
        (dir: string) => write(dir, { 'vitest.gates.config.ts': 'export default {};\n' }),
        'vitest.gates.config.ts',
      ],
      [
        'package.json',
        (dir: string) => write(dir, { 'package.json': { name: 'fixture', private: false } }),
        'package.json',
      ],
      [
        'the lock file',
        (dir: string) => write(dir, { 'package-lock.json': { lockfileVersion: 3 } }),
        'package-lock.json',
      ],
      [
        'what is installed',
        (dir: string) =>
          write(dir, { 'node_modules/.package-lock.json': { packages: { a: '2' } } }),
        'node_modules/.package-lock.json',
      ],
    ])('runs every mutant again after a change of %s', (_name, change, file) => {
      const dir = fresh({ 'node_modules/.package-lock.json': { packages: { a: '1' } } });
      mutation(dir);
      change(dir);
      expect(mutation(dir)).toEqual(forcedBy(`${CHANGED}${file}`));
      expect(mutation(dir)).toEqual(REUSED);
    });

    it('runs every mutant again when a tool was updated', () => {
      const dir = fresh({ 'node_modules/vitest/package.json': { version: '3.2.7' } });
      mutation(dir);
      write(dir, { 'node_modules/vitest/package.json': { version: '4.0.0' } });
      expect(mutation(dir)).toEqual(
        forcedBy('the tools changed since the last run: vitest 3.2.7 → 4.0.0')
      );
      // The record of a run made by another version of this tool, or on another Node.js.
      const file = path.join(dir, RECORD);
      const record = JSON.parse(fs.readFileSync(file, 'utf8'));
      expect(Object.keys(record.snapshot.environment)).toEqual(
        expect.arrayContaining(['Node.js', 'platform', 'test-gates', 'vitest'])
      );
      record.snapshot.environment['test-gates'] = '0.0.1';
      record.snapshot.environment['Node.js'] = 'v20.0.0';
      fs.writeFileSync(file, JSON.stringify(record));
      expect(mutation(dir).reason).toMatch(
        /^the tools changed since the last run: Node\.js v20\.0\.0 → v\d+\.\d+\.\d+, test-gates 0\.0\.1 → \d/
      );
    });

    it('runs every mutant again when the arguments for Stryker changed', () => {
      const dir = fresh();
      mutation(dir);
      const first = mutation(dir, '--', '--concurrency', '1');
      expect(first.reason).toBe('the arguments for Stryker are not those of the last run');
      expect(first.args).toEqual([
        'run',
        'stryker.gates.config.mjs',
        '--concurrency',
        '1',
        '--force',
      ]);
      expect(mutation(dir, '--', '--concurrency', '1').forced).toBe(false);
      expect(mutation(dir).forced).toBe(true);
    });

    it.each([
      [
        'is missing',
        (file: string) => fs.rmSync(file),
        'there is no record of the run that wrote the incremental file',
      ],
      [
        'is not JSON',
        (file: string) => fs.writeFileSync(file, '{"format":1,'),
        'there is no record of the run that wrote the incremental file',
      ],
      [
        'is empty',
        (file: string) => fs.writeFileSync(file, ''),
        'there is no record of the run that wrote the incremental file',
      ],
      [
        'has another format',
        (file: string) =>
          fs.writeFileSync(
            file,
            JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), format: 0 })
          ),
        'the record of the last run is not one this version can read',
      ],
    ])('runs every mutant again when the record %s', (_name, damage, reason) => {
      const dir = fresh();
      mutation(dir);
      damage(path.join(dir, RECORD));
      expect(mutation(dir)).toEqual(forcedBy(reason));
      expect(mutation(dir)).toEqual(REUSED);
    });

    it('runs every mutant again when the incremental file is not the one the recorded run wrote', () => {
      const dir = fresh();
      mutation(dir);
      fs.writeFileSync(path.join(dir, INCREMENTAL), '{"from":"somewhere else"}');
      expect(mutation(dir)).toEqual(
        forcedBy('the incremental file is not the one the last recorded run wrote')
      );
    });

    it('does not take the record of an earlier run for a match after a run that failed', () => {
      const dir = fresh();
      mutation(dir);
      const original = fs.readFileSync(path.join(dir, 'src/expect-true.ts'), 'utf8');
      // A change, and a run that Stryker does not finish: it leaves a partial incremental file.
      write(dir, { 'src/expect-true.ts': '// weaker\n', 'stryker-fails': '' });
      const failed = mutation(dir);
      expect(failed.status).toBe(1);
      expect(failed.forced).toBe(true);
      expect(fs.existsSync(path.join(dir, RECORD))).toBe(false);
      // The change is taken back. The files are those of the recorded run again, the results are not.
      write(dir, { 'src/expect-true.ts': original });
      fs.rmSync(path.join(dir, 'stryker-fails'));
      expect(mutation(dir)).toEqual(
        forcedBy('there is no record of the run that wrote the incremental file')
      );
      expect(mutation(dir)).toEqual(REUSED);
    });

    it('removes the record before a run that fails although nothing changed', () => {
      const dir = fresh({ 'scratch.log': '' });
      mutation(dir);
      fs.renameSync(
        path.join(dir, 'node_modules/.bin/stryker'),
        path.join(dir, 'node_modules/.bin/stryker-ok')
      );
      write(dir, { 'node_modules/.bin/stryker': '#!/usr/bin/env node\nprocess.exit(3);\n' });
      fs.chmodSync(path.join(dir, 'node_modules/.bin/stryker'), 0o755);
      expect(testGates(['mutation', '--dir', dir]).status).toBe(1);
      expect(fs.existsSync(path.join(dir, RECORD))).toBe(false);
      fs.renameSync(
        path.join(dir, 'node_modules/.bin/stryker-ok'),
        path.join(dir, 'node_modules/.bin/stryker')
      );
      expect(mutation(dir).reason).toBe(
        'there is no record of the run that wrote the incremental file'
      );
    });

    it('leaves a run with --force as it is, and records it', () => {
      const dir = fresh();
      mutation(dir);
      write(dir, { 'src/expect-true.ts': '// weaker\n' });
      expect(mutation(dir, '--', '--force')).toEqual({
        status: 0,
        forced: true,
        reason: null,
        args: ['run', 'stryker.gates.config.mjs', '--force'],
      });
      expect(mutation(dir)).toEqual(REUSED);
    });

    it('runs every mutant again after an incremental file that no record came with', () => {
      // What a version without the guard, or Stryker called directly, leaves behind.
      const dir = fresh({ [INCREMENTAL]: '{}' });
      expect(mutation(dir)).toEqual(
        forcedBy('there is no record of the run that wrote the incremental file')
      );
    });

    it('does nothing when Stryker does not run in incremental mode', () => {
      const dir = fresh({
        'stryker.gates.config.mjs': 'export default {};\n',
        [INCREMENTAL]: '{}',
      });
      expect(mutation(dir)).toEqual(REUSED);
      expect(fs.existsSync(path.join(dir, RECORD))).toBe(false);
      // --incremental on the command line turns it on.
      expect(mutation(dir, '--', '--incremental').reason).toBe(
        'there is no record of the run that wrote the incremental file'
      );
    });

    it('follows the incremental file named in the config or in the arguments', () => {
      const dir = fresh({
        'stryker.gates.config.mjs':
          "export default { incremental: true, incrementalFile: 'reports/other.json' };\n",
        'reports/other.json': '{}',
      });
      expect(mutation(dir).reason).toBe(
        'there is no record of the run that wrote the incremental file'
      );
      // The stand-in writes reports/stryker-incremental.json: tell the tool so.
      const args = ['--', '--incrementalFile', INCREMENTAL];
      expect(mutation(dir, ...args).reason).toBe(
        'there is no record of the run that wrote the incremental file'
      );
      expect(fs.existsSync(path.join(dir, RECORD))).toBe(true);
      expect(mutation(dir, ...args).forced).toBe(false);
    });

    it('runs every mutant again when the Stryker config cannot be loaded', () => {
      const dir = fresh({ 'stryker.gates.config.mjs': 'export default {\n', [INCREMENTAL]: '{}' });
      expect(mutation(dir)).toEqual(
        forcedBy('the Stryker config could not be loaded to see where the incremental file is')
      );
      expect(fs.existsSync(path.join(dir, RECORD))).toBe(false);
    });

    it('reads a Stryker config written as JSON', () => {
      const dir = fresh({ 'stryker.gates.config.mjs': 'export default {};\n' });
      fs.rmSync(path.join(dir, 'stryker.gates.config.mjs'));
      write(dir, { 'stryker.gates.config.json': { incremental: true }, [INCREMENTAL]: '{}' });
      if (kind === 'git') {
        git(dir, 'add', '-A');
      }
      const first = mutation(dir);
      expect(first.reason).toBe('there is no record of the run that wrote the incremental file');
      expect(first.args).toEqual(['run', 'stryker.gates.config.json', '--force']);
      expect(mutation(dir).forced).toBe(false);
    });

    it('does not look at what the run itself writes', () => {
      const dir = fresh();
      mutation(dir);
      write(dir, {
        '.stryker-tmp/sandbox-1/src/age.ts': 'x',
        'reports/mutation/mutation.html': 'x',
      });
      expect(mutation(dir)).toEqual(REUSED);
    });

    describe('in a repository with several packages', () => {
      const monorepo = (extra: Record<string, string | object> = {}) =>
        create(
          {
            'package.json': { name: 'root', private: true, workspaces: ['fee-rules'] },
            'package-lock.json': { lockfileVersion: 3 },
            'tsconfig.base.json': {},
            'pricing-kit/rounding/half-up.ts':
              'export const halfUp = (value: number) => Math.round(value);\n',
            'pricing-kit/rounding/README.md': 'money\n',
            'pricing-kit/labels/label-set.ts': 'export {};\n',
            'catalog-site/src/listing.ts': 'export {};\n',
            'docs/guide.md': 'guide\n',
            ...subproject('fee-rules/'),
            'fee-rules/tsconfig.json': { extends: '../tsconfig.base.json' },
            'fee-rules/src/rates.ts':
              "import { halfUp } from '../../pricing-kit/rounding/half-up';\nexport const rate = halfUp(1.5);\n",
            ...extra,
          },
          kind,
          'fee-rules'
        );
      const sub = (root: string) => path.join(root, 'fee-rules');

      it('reuses after a change in a package the subproject does not point at', () => {
        const root = monorepo();
        mutation(sub(root));
        write(root, {
          'catalog-site/src/listing.ts': 'export const listing = 1;\n',
          'docs/guide.md': 'more\n',
        });
        write(root, { 'pricing-kit/labels/label-set.ts': 'export const other = 1;\n' });
        expect(mutation(sub(root))).toEqual(REUSED);
      });

      it.each([
        ['the lock file above the subproject', 'package-lock.json', 'package-lock.json'],
        [
          'a config above the subproject that a config extends',
          'tsconfig.base.json',
          'tsconfig.base.json',
        ],
        [
          'a file outside the subproject that a file imports',
          'pricing-kit/rounding/half-up.ts',
          'pricing-kit/rounding/half-up.ts',
        ],
        [
          'another file of the directory that import leads to',
          'pricing-kit/rounding/README.md',
          'pricing-kit/rounding/README.md',
        ],
      ])('runs every mutant again after a change of %s', (_name, file, shown) => {
        const root = monorepo();
        mutation(sub(root));
        write(root, { [file]: '{"changed":true}\n' });
        expect(mutation(sub(root))).toEqual(forcedBy(`${CHANGED}${shown}`));
        expect(mutation(sub(root))).toEqual(REUSED);
      });

      it('runs every mutant again after a change in a package linked into node_modules', () => {
        const root = monorepo({ 'packages/kit/kit.ts': 'export const kit = 1;\n' });
        fs.mkdirSync(path.join(root, 'node_modules/@acme'), { recursive: true });
        fs.symlinkSync(
          path.join(root, 'packages/kit'),
          path.join(root, 'node_modules/@acme/kit'),
          'dir'
        );
        mutation(sub(root));
        write(root, { 'packages/kit/kit.ts': 'export const kit = 2;\n' });
        expect(mutation(sub(root))).toEqual(forcedBy(`${CHANGED}packages/kit/kit.ts`));
      });

      it.each([
        [
          'a path to a directory that contains the subproject',
          `export const root = join(__dirname, '${up(2)}');\n`,
        ],
        [
          'a path whose start is not known',
          "export const mapped = '<rootDir>/../pricing-kit/$1';\n",
        ],
      ])('looks at every file of the repository when a file holds %s', (_name, source) => {
        const root = monorepo({ 'fee-rules/src/paths.ts': source });
        mutation(sub(root));
        expect(mutation(sub(root))).toEqual(REUSED);
        write(root, { 'catalog-site/src/listing.ts': 'export const listing = 1;\n' });
        expect(mutation(sub(root))).toEqual(forcedBy(`${CHANGED}catalog-site/src/listing.ts`));
        // The gate and its spec stay with Stryker.
        write(root, { 'fee-rules/src/age.spec.ts': `${SPEC_SOURCE}// a comment\n` });
        expect(mutation(sub(root))).toEqual(REUSED);
      });

      it('never reuses when a path leads to a directory outside of the repository', () => {
        const root = monorepo({
          'fee-rules/src/paths.ts': `export const outside = join(__dirname, '${up(3)}');\n`,
        });
        mutation(sub(root));
        expect(fs.existsSync(path.join(sub(root), RECORD))).toBe(false);
        expect(mutation(sub(root)).reason).toMatch(
          /^the files the run depends on could not be listed \(src\/paths\.ts points outside of what can be listed \(/
        );
        expect(fs.existsSync(path.join(sub(root), RECORD))).toBe(false);
      });

      it('takes no notice of text that looks like a path to a directory that is not there', () => {
        const root = monorepo({
          'fee-rules/src/paths.ts': "export const other = '../../no-such-directory/x';\n",
        });
        mutation(sub(root));
        write(root, { 'catalog-site/src/listing.ts': 'export const listing = 1;\n' });
        expect(mutation(sub(root))).toEqual(REUSED);
      });
    });
  }
);

describe('test-gates mutation, reuse of the last run (without git)', () => {
  it('reads no further up than the directory with a .git entry', () => {
    // A checkout whose .git is there but which git cannot read, two levels above the subproject.
    const outer = create(
      {
        'sibling/notes.txt': 'not part of the checkout\n',
        'checkout/.git/HEAD': 'not a repository git can read\n',
        'checkout/package.json': { name: 'root', private: true },
        'checkout/package-lock.json': { lockfileVersion: 3 },
        'checkout/tools/unrelated.ts': 'export {};\n',
        ...subproject('checkout/services/fee-rules/'),
      },
      'walk',
      'checkout/services/fee-rules'
    );
    const dir = path.join(outer, 'checkout/services/fee-rules');
    mutation(dir);
    const record = JSON.parse(fs.readFileSync(path.join(dir, RECORD), 'utf8'));
    expect(record.snapshot.mode).toBe('walk');
    expect(Object.keys(record.snapshot.files).sort()).toEqual([
      'package-lock.json',
      'package.json',
      'services/fee-rules/package.json',
      'services/fee-rules/src/expect-true.ts',
      'services/fee-rules/stryker.gates.config.mjs',
      'services/fee-rules/test-gates.json',
    ]);
    write(outer, {
      'sibling/notes.txt': 'changed\n',
      'package.json': { name: 'above the checkout' },
    });
    expect(mutation(dir)).toEqual(REUSED);
    write(outer, { 'checkout/package-lock.json': { lockfileVersion: 2 } });
    expect(mutation(dir)).toEqual(forcedBy(`${CHANGED}package-lock.json`));
  });

  it('stays in the subproject when nothing above it says where the project ends', () => {
    const outer = create(
      { 'package.json': { name: 'not a workspace root' }, ...subproject('fee-rules/') },
      'walk',
      'fee-rules'
    );
    const dir = path.join(outer, 'fee-rules');
    mutation(dir);
    const record = JSON.parse(fs.readFileSync(path.join(dir, RECORD), 'utf8'));
    expect(Object.keys(record.snapshot.files).sort()).toEqual([
      'package.json',
      'src/expect-true.ts',
      'stryker.gates.config.mjs',
      'test-gates.json',
    ]);
    write(outer, { 'package.json': { name: 'changed' } });
    expect(mutation(dir)).toEqual(REUSED);
    // A lock file and what is installed are looked at by name, also above the subproject.
    write(outer, { 'package-lock.json': { lockfileVersion: 3 } });
    expect(mutation(dir)).toEqual(forcedBy(`${CHANGED}../package-lock.json`));
    write(outer, { 'node_modules/.package-lock.json': { packages: {} } });
    expect(mutation(dir)).toEqual(forcedBy(`${CHANGED}../node_modules/.package-lock.json`));
    expect(mutation(dir)).toEqual(REUSED);
  });
});

describe('test-gates mutation, reuse of the last run (git only)', () => {
  const fresh = () => create({ ...subproject(), 'scratch.log': '' }, 'git');

  it('does not look at files git ignores', () => {
    const dir = fresh();
    mutation(dir);
    write(dir, { 'scratch.log': 'noise\n' });
    expect(mutation(dir)).toEqual(REUSED);
  });

  it('runs every mutant again after a switch to a branch with another helper, and after the switch back', () => {
    const dir = fresh();
    git(dir, 'checkout', '-q', '-b', 'weaker');
    write(dir, { 'src/expect-true.ts': '// weaker\n' });
    git(dir, 'commit', '-q', '-am', 'weaker');
    git(dir, 'checkout', '-q', 'main');
    mutation(dir);
    git(dir, 'checkout', '-q', 'weaker');
    expect(mutation(dir)).toEqual(forcedBy(`${CHANGED}src/expect-true.ts`));
    git(dir, 'checkout', '-q', 'main');
    expect(mutation(dir)).toEqual(forcedBy(`${CHANGED}src/expect-true.ts`));
  });

  it('reuses after a switch to a branch that differs only in a gate', () => {
    const dir = fresh();
    git(dir, 'checkout', '-q', '-b', 'gate-only');
    write(dir, { 'src/age.ts': `${GATE_SOURCE}// changed\n` });
    git(dir, 'commit', '-q', '-am', 'gate');
    git(dir, 'checkout', '-q', 'main');
    mutation(dir);
    git(dir, 'checkout', '-q', 'gate-only');
    expect(mutation(dir)).toMatchObject({ forced: false, reason: null });
  });

  it('runs every mutant again after a stash took a change away', () => {
    const dir = fresh();
    write(dir, { 'src/expect-true.ts': '// work in progress\n' });
    mutation(dir);
    git(dir, 'stash', '-q');
    expect(mutation(dir)).toEqual(forcedBy(`${CHANGED}src/expect-true.ts`));
    git(dir, 'stash', 'pop', '-q');
    expect(mutation(dir)).toEqual(forcedBy(`${CHANGED}src/expect-true.ts`));
  });

  it('reads the directories when git does not list the subproject', () => {
    const root = create(
      {
        '.gitignore': `${IGNORE}generated\n`,
        'README.md': 'x\n',
        ...subproject('generated/fee-rules/'),
      },
      'git',
      'generated/fee-rules'
    );
    const dir = path.join(root, 'generated/fee-rules');
    mutation(dir);
    expect(JSON.parse(fs.readFileSync(path.join(dir, RECORD), 'utf8')).snapshot.mode).toBe('walk');
    write(dir, { 'src/expect-true.ts': '// weaker\n' });
    expect(mutation(dir).reason).toBe(`${CHANGED}generated/fee-rules/src/expect-true.ts`);
  });
});
