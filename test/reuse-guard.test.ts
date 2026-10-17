import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
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
// Every test here starts several processes and waits for each. Without a pause between the
// tests the worker never gets to its messages, and Vitest gives up on it after a minute.
afterEach(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

// A stand-in for node_modules/.bin/stryker. It records its arguments and, like Stryker in
// incremental mode, writes a report and an incremental file. With a file `.stryker-tmp/fails`
// it writes the incremental file and then fails, as an interrupted run does; with
// `.stryker-tmp/silent` it ends well without writing one, as a dry run does.
const FAKE_STRYKER = `#!/usr/bin/env node
const fs = require('node:fs');
fs.mkdirSync('reports/mutation', { recursive: true });
fs.mkdirSync('.stryker-tmp', { recursive: true });
fs.writeFileSync('.stryker-tmp/stryker-args.json', JSON.stringify(process.argv.slice(2)));
if (!fs.existsSync('.stryker-tmp/silent')) {
  fs.writeFileSync('reports/stryker-incremental.json', JSON.stringify({ written: process.hrtime.bigint().toString() }));
}
if (fs.existsSync('.stryker-tmp/fails')) process.exit(1);
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
    fs.readFileSync(path.join(dir, '.stryker-tmp/stryker-args.json'), 'utf8')
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
const CHANGED = 'changed since the last run: ';

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

    it('runs every mutant again when a gate or a spec changed: Stryker compares only the place of each mutant', () => {
      const dir = fresh();
      mutation(dir);
      write(dir, { 'src/age.spec.ts': `${SPEC_SOURCE}// a comment\n` });
      expect(mutation(dir)).toEqual(forcedBy(`${CHANGED}src/age.spec.ts`));
      expect(mutation(dir)).toEqual(REUSED);
      // (The stand-in's report is that of the unchanged gate, so the judge rejects it afterwards.)
      write(dir, { 'src/age.ts': `${GATE_SOURCE}// a comment\n` });
      expect(mutation(dir)).toMatchObject({ forced: true, reason: `${CHANGED}src/age.ts` });
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
      write(dir, { 'src/expect-true.ts': '// weaker\n', '.stryker-tmp/fails': '' });
      const failed = mutation(dir);
      expect(failed.status).toBe(1);
      expect(failed.forced).toBe(true);
      expect(fs.existsSync(path.join(dir, RECORD))).toBe(false);
      // The change is taken back. The files are those of the recorded run again, the results are not.
      write(dir, { 'src/expect-true.ts': original });
      fs.rmSync(path.join(dir, '.stryker-tmp/fails'));
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

    it('takes nothing over in a run with --gate, and leaves no record of it', () => {
      const dir = fresh();
      // First run of all: there is no incremental file to take anything from.
      expect(mutation(dir, '--gate', 'src/age.ts')).toEqual({
        status: 0,
        forced: false,
        reason: null,
        args: ['run', 'stryker.gates.config.mjs', '--mutate', 'src/age.ts'],
      });
      expect(fs.existsSync(path.join(dir, RECORD))).toBe(false);
      // The run without --gate after it: the incremental file is one no record came with.
      expect(mutation(dir)).toEqual(
        forcedBy('there is no record of the run that wrote the incremental file')
      );
      expect(mutation(dir)).toEqual(REUSED);
      // Nothing changed, and a run with --gate still runs every mutant of its gate ...
      expect(mutation(dir, '--gate', 'src/age.ts')).toEqual({
        status: 0,
        forced: true,
        reason: 'with --gate nothing is taken over from an earlier run',
        args: ['run', 'stryker.gates.config.mjs', '--mutate', 'src/age.ts', '--force'],
      });
      // ... and takes the record away, so that the next run is one of every mutant too.
      expect(fs.existsSync(path.join(dir, RECORD))).toBe(false);
      expect(mutation(dir)).toEqual(
        forcedBy('there is no record of the run that wrote the incremental file')
      );
      // With --force given, nothing is added.
      expect(mutation(dir, '--gate', 'src/age.ts', '--force')).toEqual({
        status: 0,
        forced: true,
        reason: null,
        args: ['run', 'stryker.gates.config.mjs', '--force', '--mutate', 'src/age.ts'],
      });
      expect(fs.existsSync(path.join(dir, RECORD))).toBe(false);
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

    it('looks at the other files when the report is written into the subproject itself', () => {
      const dir = fresh({
        'test-gates.json': {
          gates: [gateEntry],
          candidates: [],
          settings: { stryker: { reportFile: 'mutation.json' } },
        },
      });
      mutation(dir);
      // (Without git, the stand-in's own report, written elsewhere, is a new file once.)
      mutation(dir);
      expect(mutation(dir).forced).toBe(false);
      write(dir, { 'src/expect-true.ts': '// weaker\n' });
      expect(mutation(dir).reason).toBe(`${CHANGED}src/expect-true.ts`);
    });

    it('does not record a run after which the incremental file is what it was before', () => {
      const dir = fresh();
      mutation(dir);
      // A change, and a run that ends well without writing an incremental file.
      write(dir, { 'src/expect-true.ts': '// weaker\n', '.stryker-tmp/silent': '' });
      expect(mutation(dir).forced).toBe(true);
      expect(fs.existsSync(path.join(dir, RECORD))).toBe(false);
      fs.rmSync(path.join(dir, '.stryker-tmp/silent'));
      expect(mutation(dir).reason).toBe(
        'there is no record of the run that wrote the incremental file'
      );
    });

    it.each(['constructor', 'toString', '__proto__'])('looks at a file named %s', (name) => {
      const dir = fresh({ [name]: 'first\n' });
      mutation(dir);
      const record = JSON.parse(fs.readFileSync(path.join(dir, RECORD), 'utf8'));
      expect(Object.keys(record.snapshot.files)).toContain(name);
      fs.writeFileSync(path.join(dir, name), 'second\n');
      expect(mutation(dir)).toEqual(forcedBy(`${CHANGED}${name}`));
    });

    it('reuses every result with --affected after no change, where it cannot tell the gates apart', () => {
      // The stand-in's config names no test runner: what a gate depends on cannot be told.
      const dir = fresh();
      expect(mutation(dir, '--affected').forced).toBe(true);
      const again = testGates(['mutation', '--dir', dir, '--affected']);
      expect(again.stdout).toContain(
        'test-gates mutation --affected: nothing changed since the last run, every result is reused (gate by gate, what each gate depends on cannot be told:'
      );
      expect(mutation(dir, '--affected')).toEqual({ ...REUSED, args: REUSED.args });
      write(dir, { 'src/age.spec.ts': `${SPEC_SOURCE}// a comment\n` });
      const changed = mutation(dir, '--affected');
      expect(changed.forced).toBe(true);
    });

    it('does not look at what the run itself writes', () => {
      const dir = fresh();
      mutation(dir);
      write(dir, { '.stryker-tmp/sandbox-1/src/age.ts': 'x' });
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
        ['a config directly above the subproject', 'tsconfig.base.json', 'tsconfig.base.json'],
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
          'a relative path to a directory that contains the subproject',
          `export const root = readdirSync('${up(2)}');\n`,
        ],
        [
          'a path whose start is not known',
          "export const mapped = '<rootDir>/../pricing-kit/$1';\n",
        ],
        [
          'a way up from a directory that is not the one of the file',
          `export const top = resolve(base, '${up(1)}');\n`,
        ],
        [
          'a way up from the directory of the file with an unknown part after it',
          `export const kit = (name: string) => join(__dirname, '${up(2)}', name);\n`,
        ],
        [
          'a way up from the directory of the file whose result is added to',
          `export const kit = (name: string) => join(resolve(__dirname, '${up(2)}'), name);\n`,
        ],
        [
          'a way up from the directory of the file in a template that is added to',
          'export const kit = (name: string) => `${join(__dirname, ' +
            `'${up(2)}'` +
            ')}/${name}`;\n',
        ],
        [
          'a way up after a placeholder',
          'export const kit = (name: string) => `${__dirname}/${name}/' + `${up(3)}` + '`;\n',
        ],
        [
          'a relative path with a way up after a placeholder',
          'export const kit = (name: string) => `' + `${up(1)}` + '/${name}/' + `${up(2)}` + '`;\n',
        ],
      ])('looks at every file of the repository when a file holds %s', (_name, source) => {
        const root = monorepo({ 'fee-rules/src/paths.ts': source });
        mutation(sub(root));
        expect(mutation(sub(root))).toEqual(REUSED);
        write(root, { 'catalog-site/src/listing.ts': 'export const listing = 1;\n' });
        expect(mutation(sub(root))).toEqual(forcedBy(`${CHANGED}catalog-site/src/listing.ts`));
        expect(mutation(sub(root))).toEqual(REUSED);
      });

      it('follows no path in a file the run does not load, when the runner config is made by this tool', () => {
        const root = monorepo({
          'fee-rules/stryker.gates.config.mjs':
            "export default { incremental: true, testRunner: 'vitest', vitest: { configFile: 'vitest.gates.config.ts' } };\n",
          'fee-rules/vitest.gates.config.ts':
            "import { createVitestGatesConfig } from '@t09tanaka/test-gates/vitest';\nexport default createVitestGatesConfig();\n",
          'fee-rules/eslint.config.js': `export default { patterns: ['${up(1)}/'] };\n`,
          // A path for the sandbox of Stryker: from the subproject it leads above the repository.
          'fee-rules/jest.paths.cjs': `module.exports = require('path').resolve(__dirname, '${up(2)}/kit');\n`,
        });
        mutation(sub(root));
        write(root, { 'catalog-site/src/listing.ts': 'export const listing = 1;\n' });
        expect(mutation(sub(root))).toEqual(REUSED);
        write(root, { 'fee-rules/eslint.config.js': 'export default {};\n' });
        expect(mutation(sub(root))).toEqual(forcedBy(`${CHANGED}fee-rules/eslint.config.js`));
        // Loaded by the runner config, the file is followed: where its path leads, nothing is
        // there, and that is compared.
        write(root, {
          'fee-rules/vitest.gates.config.ts':
            "import { createVitestGatesConfig } from '@t09tanaka/test-gates/vitest';\nimport kit from './jest.paths.cjs';\nexport default createVitestGatesConfig({ kit });\n",
        });
        mutation(sub(root));
        const record = JSON.parse(fs.readFileSync(path.join(sub(root), RECORD), 'utf8'));
        expect(record.snapshot.files[`${up(1)}/kit`]).toBe('missing');
        write(root, { 'catalog-site/src/listing.ts': 'export const listing = 2;\n' });
        expect(mutation(sub(root))).toEqual(REUSED);
      });

      it('compares no more when a config extends a file directly in a directory above the subproject', () => {
        const root = monorepo({ 'fee-rules/tsconfig.json': { extends: '../tsconfig.base.json' } });
        mutation(sub(root));
        write(root, { 'catalog-site/src/listing.ts': 'export const listing = 1;\n' });
        expect(mutation(sub(root))).toEqual(REUSED);
        write(root, { 'tsconfig.base.json': { changed: true } });
        expect(mutation(sub(root))).toEqual(forcedBy(`${CHANGED}tsconfig.base.json`));
      });

      it('follows what the file above the subproject that a config extends points at', () => {
        const root = monorepo({
          'fee-rules/tsconfig.json': { extends: `${up(1)}/tsconfig.base.json` },
          'tsconfig.base.json': { extends: './configs/strict.json' },
          'configs/strict.json': { compilerOptions: { strict: true } },
        });
        mutation(sub(root));
        write(root, { 'catalog-site/src/listing.ts': 'export const listing = 1;\n' });
        expect(mutation(sub(root))).toEqual(REUSED);
        write(root, { 'configs/strict.json': { compilerOptions: { strict: false } } });
        expect(mutation(sub(root))).toEqual(forcedBy(`${CHANGED}configs/strict.json`));
      });

      it('follows each file above the subproject that a path without its extension may stand for', () => {
        const root = monorepo({
          'fee-rules/tsconfig.json': { extends: `${up(1)}/shared` },
          'shared.js': 'module.exports = {};\n',
          'shared.json': { extends: './configs/strict.json' },
          'configs/strict.json': { compilerOptions: { strict: true } },
        });
        mutation(sub(root));
        write(root, { 'catalog-site/src/listing.ts': 'export const listing = 1;\n' });
        expect(mutation(sub(root))).toEqual(REUSED);
        write(root, { 'configs/strict.json': { compilerOptions: { strict: false } } });
        expect(mutation(sub(root))).toEqual(forcedBy(`${CHANGED}configs/strict.json`));
      });

      it('looks at every file of the repository when the file above the subproject that a config extends points at a place it cannot tell', () => {
        const root = monorepo({
          'fee-rules/tsconfig.json': { extends: `${up(1)}/tsconfig.base.json` },
          'tsconfig.base.json': { extends: './${PRESET}/tsconfig.json' },
        });
        mutation(sub(root));
        write(root, { 'catalog-site/src/listing.ts': 'export const listing = 1;\n' });
        expect(mutation(sub(root))).toEqual(forcedBy(`${CHANGED}catalog-site/src/listing.ts`));
      });

      it.each([
        ['a file that is not there', `${up(1)}/tsconfig.missing.json`],
        ['a directory', `${up(1)}/pricing-kit`],
        ['a file deeper above the subproject', `${up(1)}/pricing-kit/labels/label-set.ts`],
      ])('still looks at more when a plain path leads up to %s', (_name, reference) => {
        const root = monorepo({ 'fee-rules/tsconfig.json': { extends: reference } });
        mutation(sub(root));
        write(root, { 'pricing-kit/labels/label-set.ts': 'export const labels = 2;\n' });
        expect(mutation(sub(root)).forced).toBe(true);
      });

      it.each([
        [
          'written in separate parts',
          'fee-rules/src/nested/load.ts',
          `export const kit = require(join(__dirname, '${up(1)}', '${up(1)}', '${up(1)}', 'pricing-kit', 'labels'));\n`,
        ],
        [
          'written in one part',
          'fee-rules/src/load.ts',
          `export const kit = require(resolve(import.meta.dirname, '${up(2)}/pricing-kit/labels'));\n`,
        ],
        [
          'in a template',
          'fee-rules/src/load.ts',
          'export const kit = (name: string) => require(`${__dirname}/' +
            `${up(2)}/pricing-kit/labels/` +
            '${name}`);\n',
        ],
      ])(
        'follows a way up from the directory of the file %s, and only that',
        (_name, file, source) => {
          const root = monorepo({ [file]: source });
          mutation(sub(root));
          write(root, { 'catalog-site/src/listing.ts': 'export const listing = 1;\n' });
          expect(mutation(sub(root))).toEqual(REUSED);
          write(root, { 'pricing-kit/labels/label-set.ts': 'export const labels = 1;\n' });
          expect(mutation(sub(root))).toEqual(
            forcedBy(`${CHANGED}pricing-kit/labels/label-set.ts`)
          );
        }
      );

      it.each([
        [
          'the subproject itself, in a template',
          'fee-rules/scripts/run.js',
          '`${__dirname}/' + `${up(1)}` + '`',
        ],
        [
          'the subproject itself, as separate parts',
          'fee-rules/src/nested/run.ts',
          `join(__dirname, '${up(1)}', '${up(1)}')`,
        ],
        [
          'the directory above the subproject',
          'fee-rules/paths.cjs',
          `path.resolve(__dirname, '${up(1)}')`,
        ],
      ])(
        'compares no more when a way up from the directory of the file leads to %s',
        (_name, file, expression) => {
          const root = monorepo({ [file]: `module.exports = ${expression};\n` });
          mutation(sub(root));
          write(root, { 'catalog-site/src/listing.ts': 'export const listing = 1;\n' });
          expect(mutation(sub(root))).toEqual(REUSED);
          // What is directly in the directory above is compared, as it always is.
          write(root, { 'tsconfig.base.json': { changed: true } });
          expect(mutation(sub(root))).toEqual(forcedBy(`${CHANGED}tsconfig.base.json`));
        }
      );

      it('compares no more when an import leads up to a file at the top of the subproject', () => {
        const root = monorepo({
          'fee-rules/helper.ts': 'export const helper = 1;\n',
          'fee-rules/src/nested/use.ts': `export { helper } from '${up(2)}/helper';\n`,
        });
        mutation(sub(root));
        write(root, { 'catalog-site/src/listing.ts': 'export const listing = 1;\n' });
        expect(mutation(sub(root))).toEqual(REUSED);
        write(root, { 'fee-rules/helper.ts': 'export const helper = 2;\n' });
        expect(mutation(sub(root))).toEqual(forcedBy(`${CHANGED}fee-rules/helper.ts`));
      });

      it.each([
        ['NOTES.md', 'reuses'],
        ['notes.txt', 'reuses'],
        ['report.html', 'reuses'],
        ['notes.ts', 'does not reuse'],
      ])(
        'compares %s but follows no path in it unless it is code: %s after a change elsewhere',
        (name, outcome) => {
          const file = `fee-rules/${name}`;
          const text = `Run it from '${up(1)}', or read('${up(1)}/catalog-site').\n`;
          const root = monorepo({ [file]: text });
          mutation(sub(root));
          write(root, { 'catalog-site/src/listing.ts': 'export const listing = 1;\n' });
          expect(mutation(sub(root))).toEqual(
            outcome === 'reuses' ? REUSED : forcedBy(`${CHANGED}catalog-site/src/listing.ts`)
          );
          write(root, { [file]: `${text}More.\n` });
          expect(mutation(sub(root))).toEqual(forcedBy(`${CHANGED}${file}`));
        }
      );

      it('follows the fixed part of a path with a placeholder', () => {
        const root = monorepo({
          'pricing-kit/tables/de.json': {},
          'fee-rules/src/tables.ts':
            'export const table = (name: string) => require(`' +
            `${up(2)}/pricing-kit/tables/` +
            '${name}.json`);\n',
        });
        mutation(sub(root));
        write(root, { 'catalog-site/src/listing.ts': 'export const listing = 1;\n' });
        expect(mutation(sub(root))).toEqual(REUSED);
        write(root, { 'pricing-kit/tables/de.json': { changed: true } });
        expect(mutation(sub(root))).toEqual(forcedBy(`${CHANGED}pricing-kit/tables/de.json`));
      });

      it.each([
        ['a file', 'pricing-kit/labels/label-set.ts', 'fee-rules/src/labels.ts'],
        ['a directory', 'pricing-kit/labels', 'fee-rules/src/labels'],
      ])('looks at what a link to %s outside the subproject leads to', (_name, target, link) => {
        const root = monorepo();
        fs.symlinkSync(
          path.relative(path.dirname(path.join(root, link)), path.join(root, target)),
          path.join(root, link)
        );
        if (kind === 'git') {
          git(root, 'add', '-A');
        }
        mutation(sub(root));
        expect(mutation(sub(root))).toEqual(REUSED);
        write(root, { 'pricing-kit/labels/label-set.ts': 'export const labels = 1;\n' });
        expect(mutation(sub(root))).toEqual(forcedBy(`${CHANGED}pricing-kit/labels/label-set.ts`));
      });

      it('never reuses when node_modules links a directory outside of the repository', () => {
        const root = monorepo();
        const elsewhere = project({ 'kit-entry.js': 'module.exports = 1;\n' });
        fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
        fs.symlinkSync(elsewhere, path.join(root, 'node_modules/outside-kit'), 'dir');
        mutation(sub(root));
        expect(mutation(sub(root)).reason).toMatch(
          /^the files the run depends on could not be listed \(.*outside-kit is a link to a directory outside of what can be listed/
        );
      });

      it('never reuses when a path leads to a directory outside of the repository', () => {
        const root = monorepo({
          'fee-rules/src/paths.ts': `export const outside = join(__dirname, '${up(3)}');\n`,
        });
        mutation(sub(root));
        expect(fs.existsSync(path.join(sub(root), RECORD))).toBe(false);
        expect(mutation(sub(root)).reason).toMatch(
          /^the files the run depends on could not be listed \(src\/paths\.ts points outside of what can be listed with "__dirname, '\.\.\/\.\.\/\.\.'" \(/
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
  it('reuses when the subproject is reached through a link', () => {
    const dir = create(subproject(), 'walk');
    const alias = `${dir}-alias`;
    fs.symlinkSync(dir, alias, 'dir');
    try {
      mutation(alias);
      expect(mutation(alias)).toEqual(REUSED);
    } finally {
      fs.rmSync(alias);
    }
  });

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
      'services/fee-rules/src/age.spec.ts',
      'services/fee-rules/src/age.ts',
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
      'src/age.spec.ts',
      'src/age.ts',
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

  it('runs every mutant again after a switch to a branch that differs only in a gate', () => {
    const dir = fresh();
    git(dir, 'checkout', '-q', '-b', 'gate-only');
    write(dir, { 'src/age.ts': `${GATE_SOURCE}// changed\n` });
    git(dir, 'commit', '-q', '-am', 'gate');
    git(dir, 'checkout', '-q', 'main');
    mutation(dir);
    git(dir, 'checkout', '-q', 'gate-only');
    expect(mutation(dir)).toMatchObject({ forced: true, reason: `${CHANGED}src/age.ts` });
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

  it('reads what is in a repository inside the repository', () => {
    const dir = create(
      { ...subproject(), 'vendor-kit/helper.js': 'module.exports = 1;\n' },
      'walk'
    );
    git(path.join(dir, 'vendor-kit'), 'init', '-q', '-b', 'main');
    git(path.join(dir, 'vendor-kit'), 'add', '-A');
    git(path.join(dir, 'vendor-kit'), 'commit', '-q', '-m', 'first');
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'first');
    mutation(dir);
    expect(mutation(dir)).toEqual(REUSED);
    // Not committed in the inner repository: its HEAD stays what it was.
    write(dir, { 'vendor-kit/helper.js': 'module.exports = 2;\n' });
    expect(mutation(dir)).toEqual(forcedBy(`${CHANGED}vendor-kit/helper.js`));
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

describe('test-gates mutation, reuse of the last run (what the comparison reaches)', () => {
  const STRYKER_WITH_HELPER =
    "export default { incremental: true, testRunner: 'vitest', vitest: { configFile: 'vitest.gates.config.ts' } };\n";
  const VITEST_WITH_HELPER =
    "import { createVitestGatesConfig } from '@t09tanaka/test-gates/vitest';\nexport default createVitestGatesConfig();\n";
  /** A repository with a workspace `fee-rules` and the given files besides. */
  const repository = (extra: Record<string, string | object> = {}, sub = 'fee-rules') =>
    create(
      {
        'package.json': { name: 'root', private: true, workspaces: [sub] },
        'package-lock.json': { lockfileVersion: 3 },
        'catalog-site/src/listing.ts': 'export {};\n',
        ...subproject(`${sub}/`),
        ...extra,
      },
      'git',
      sub
    );

  it('compares a directory outside the subproject whose name has glob characters', () => {
    const root = repository({
      'shared/[rates]/rate.ts': 'export const rate = 1;\n',
      'fee-rules/src/rate.ts': `export { rate } from '${up(2)}/shared/[rates]/rate';\n`,
    });
    const dir = path.join(root, 'fee-rules');
    mutation(dir);
    const record = JSON.parse(fs.readFileSync(path.join(dir, RECORD), 'utf8'));
    expect(record.snapshot.files['shared/[rates]/rate.ts']).toMatch(/^[0-9a-f]{64}$/);
    write(root, { 'shared/[rates]/rate.ts': 'export const rate = 2;\n' });
    expect(mutation(dir)).toEqual(forcedBy(`${CHANGED}shared/[rates]/rate.ts`));
  });

  // (Not a backslash: Node.js does not import a module from such a path.)
  it.each(['[app]', 'app*', 'app?'])('lists a subproject named %s with git', (name) => {
    const sub = `apps/${name}`;
    const root = repository({ [`${sub}/scratch.log`]: '' }, sub);
    const dir = path.join(root, sub);
    mutation(dir);
    const record = JSON.parse(fs.readFileSync(path.join(dir, RECORD), 'utf8'));
    expect(record.snapshot.mode).toBe('git');
    // git ignores the log: a change to it is no reason to run every mutant.
    write(dir, { 'scratch.log': 'noise\n' });
    expect(mutation(dir)).toEqual(REUSED);
    write(dir, { 'src/expect-true.ts': '// weaker\n' });
    expect(mutation(dir)).toEqual(forcedBy(`${CHANGED}${sub}/src/expect-true.ts`));
  });

  it.each([
    [
      'a spec that reads a file',
      'fee-rules/src/rate.spec-data.ts',
      `export const rate = JSON.parse(readFileSync('${up(1)}/shared-data/rate.json', 'utf8'));\n`,
    ],
    [
      'a setup file that resolves a path',
      'fee-rules/test/setup.ts',
      `globalThis.rateFile = path.resolve('${up(1)}/shared-data/rate.json');\n`,
    ],
  ])('follows a way up from the directory the run starts in, for %s', (_name, file, source) => {
    const root = repository({ 'shared-data/rate.json': { rate: 1 }, [file]: source });
    const dir = path.join(root, 'fee-rules');
    mutation(dir);
    write(root, { 'catalog-site/src/listing.ts': 'export const listing = 1;\n' });
    expect(mutation(dir)).toEqual(REUSED);
    write(root, { 'shared-data/rate.json': { rate: 2 } });
    expect(mutation(dir)).toEqual(forcedBy(`${CHANGED}shared-data/rate.json`));
  });

  it('follows a way up from the directory the run starts in also when the path is there from the file', () => {
    const root = repository({
      'shared-data/rate.json': { rate: 1 },
      'fee-rules/src/shared-data/rate.json': { rate: 1 },
      'fee-rules/src/nested/rate.spec-data.ts': `export const rate = readFileSync('${up(1)}/shared-data/rate.json');\n`,
    });
    const dir = path.join(root, 'fee-rules');
    mutation(dir);
    expect(mutation(dir)).toEqual(REUSED);
    write(root, { 'shared-data/rate.json': { rate: 2 } });
    expect(mutation(dir)).toEqual(forcedBy(`${CHANGED}shared-data/rate.json`));
  });

  it('notices a file that appears where a way up from the directory the run starts in leads', () => {
    const root = repository({
      'fee-rules/src/rate.spec-data.ts': `export const rate = readFileSync('${up(1)}/shared-data/rate.json');\n`,
    });
    const dir = path.join(root, 'fee-rules');
    mutation(dir);
    expect(mutation(dir)).toEqual(REUSED);
    write(root, { 'shared-data/rate.json': { rate: 2 } });
    expect(mutation(dir)).toEqual(forcedBy(`${CHANGED}shared-data/rate.json`));
  });

  it('compares a file git ignores when the run loads it, with the helper of the runner config', () => {
    const root = repository({
      '.gitignore': `${IGNORE}generated/\ntest-fixtures/\n`,
      'fee-rules/stryker.gates.config.mjs': STRYKER_WITH_HELPER,
      'fee-rules/vitest.gates.config.ts': VITEST_WITH_HELPER,
      'fee-rules/src/generated/limit.ts': 'export const limit = 18;\n',
      'fee-rules/test-fixtures/cases.json': { ages: [18] },
      'fee-rules/test-fixtures/unused.json': { ages: [] },
      'fee-rules/src/age.spec.ts':
        "import { limit } from './generated/limit';\n" +
        `import cases from '${up(1)}/test-fixtures/cases.json';\n` +
        SPEC_SOURCE,
    });
    const dir = path.join(root, 'fee-rules');
    mutation(dir);
    expect(mutation(dir)).toEqual(REUSED);
    // Ignored and not loaded: not compared.
    write(dir, { 'test-fixtures/unused.json': { ages: [1] } });
    expect(mutation(dir)).toEqual(REUSED);
    write(dir, { 'src/generated/limit.ts': 'export const limit = 21;\n' });
    expect(mutation(dir)).toEqual(forcedBy(`${CHANGED}fee-rules/src/generated/limit.ts`));
    write(dir, { 'test-fixtures/cases.json': { ages: [] } });
    expect(mutation(dir)).toEqual(forcedBy(`${CHANGED}fee-rules/test-fixtures/cases.json`));
    expect(mutation(dir)).toEqual(REUSED);
  });

  it('does not compare the reports of the run and what Stryker leaves out, that its config names', () => {
    const root = repository({
      '.gitignore': `${IGNORE}generated/\n.eslintcache\n*.tsbuildinfo\n`,
      'fee-rules/stryker.gates.config.mjs':
        "export default { incremental: true, testRunner: 'vitest', vitest: { configFile: 'vitest.gates.config.ts' }, htmlReporter: { fileName: 'reports/mutation/gates.html' }, jsonReporter: { fileName: 'reports/gates.json' }, ignorePatterns: ['.eslintcache', 'tsconfig.tsbuildinfo'] };\n",
      'fee-rules/vitest.gates.config.ts': VITEST_WITH_HELPER,
      'fee-rules/src/generated/limit.ts': 'export const limit = 18;\n',
      'fee-rules/src/age.spec.ts': "import { limit } from './generated/limit';\n" + SPEC_SOURCE,
    });
    const dir = path.join(root, 'fee-rules');
    // What a report and a cache hold: paths that lead anywhere, and change on every run.
    const written = (run: number) => ({
      'reports/mutation/gates.html': `<pre>at ${up(2)}/node_modules/expect/build/index.js:${run}</pre>\n`,
      'reports/gates.json': { run, file: `${up(3)}/elsewhere/x.ts` },
      '.eslintcache': { run, file: `${up(3)}/elsewhere/y.ts` },
      'tsconfig.tsbuildinfo': { run, file: `${up(3)}/elsewhere/z.ts` },
    });
    write(dir, written(1));
    mutation(dir);
    expect(mutation(dir)).toEqual(REUSED);
    write(dir, written(2));
    expect(mutation(dir)).toEqual(REUSED);
    // Generated code that git ignores and the run loads is still compared.
    write(dir, { 'src/generated/limit.ts': 'export const limit = 21;\n' });
    expect(mutation(dir)).toEqual(forcedBy(`${CHANGED}fee-rules/src/generated/limit.ts`));
  });

  it.each([
    ['the root', 'patches/kit+1.0.0.patch'],
    ['the subproject', 'fee-rules/patches/kit+1.0.0.patch'],
  ])('compares the patches of patch-package in %s', (_name, file) => {
    const root = repository({ [file]: 'a patch\n' });
    const dir = path.join(root, 'fee-rules');
    mutation(dir);
    expect(mutation(dir)).toEqual(REUSED);
    write(root, { [file]: 'another patch\n' });
    expect(mutation(dir)).toEqual(forcedBy(`${CHANGED}${file}`));
  });

  it('runs every mutant again when Stryker would start under another Node.js', () => {
    const dir = create(subproject(), 'git');
    // A node on PATH, as the shebang of node_modules/.bin/stryker finds it, that says it is
    // another version and otherwise is the real one.
    const bin = path.join(dir, '.stryker-tmp/bin');
    fs.mkdirSync(bin, { recursive: true });
    const fake = path.join(bin, 'node');
    const run = (version: string) => {
      fs.writeFileSync(
        fake,
        `#!/bin/sh\nif [ "$1" = "--version" ]; then echo ${version}; else exec ${JSON.stringify(process.execPath)} "$@"; fi\n`
      );
      fs.chmodSync(fake, 0o755);
      const result = testGates(['mutation', '--dir', dir], {
        env: { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}` },
      });
      return result.stdout.split('\n').find((line) => line.startsWith(NOTE)) ?? null;
    };
    run('v1.0.0');
    expect(run('v1.0.0')).toBeNull();
    expect(run('v2.0.0')).toBe(
      `${NOTE}the tools changed since the last run: Node.js on PATH v1.0.0 → v2.0.0`
    );
  });
});

describe('test-gates mutation in a new linked worktree', () => {
  const SEED =
    'test-gates mutation: this worktree has no record of its own, so it starts from the one of the main worktree (';
  const linkedDirs: string[] = [];
  afterAll(() => linkedDirs.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

  /** The main worktree after a run of every mutant, and a linked worktree of it that has none. */
  function worktrees(): { main: string; linked: string } {
    const main = fs.realpathSync(create(subproject(), 'git'));
    expect(mutation(main)).toEqual(REUSED);
    const linked = `${main}-linked`;
    linkedDirs.push(linked);
    git(main, 'worktree', 'add', '-q', '-b', 'linked', linked);
    // node_modules is ignored by git, as the incremental file and the record are.
    fs.cpSync(path.join(main, 'node_modules'), path.join(linked, 'node_modules'), {
      recursive: true,
    });
    fs.chmodSync(path.join(linked, 'node_modules/.bin/stryker'), 0o755);
    return { main, linked };
  }
  const read = (file: string) => fs.readFileSync(file, 'utf8');
  const firstLine = (dir: string) =>
    testGates(['mutation', '--dir', dir]).stdout.split('\n')[0] ?? '';

  it('starts from the record of the main worktree and reuses every result when nothing differs', () => {
    const { main, linked } = worktrees();
    const before = {
      incremental: read(path.join(main, INCREMENTAL)),
      record: read(path.join(main, RECORD)),
    };
    expect(testGates(['doctor', '--dir', linked]).stdout).toContain(
      `  this worktree has no record of its own: the next run starts from the one of the main worktree (${main})`
    );
    const result = testGates(['mutation', '--dir', linked]);
    expect(result.stdout.split('\n')[0]).toBe(`${SEED}${main})`);
    const args = JSON.parse(read(path.join(linked, '.stryker-tmp/stryker-args.json'))) as string[];
    expect(args).toEqual(REUSED.args);
    // The run wrote its own record, and the next one reuses it without the main worktree.
    expect(fs.existsSync(path.join(linked, RECORD))).toBe(true);
    expect(firstLine(linked)).not.toContain('main worktree');
    expect(mutation(linked)).toEqual(REUSED);
    // The files of the main worktree are not written.
    expect(read(path.join(main, INCREMENTAL))).toBe(before.incremental);
    expect(read(path.join(main, RECORD))).toBe(before.record);
  });

  it('copies the incremental file of the main worktree into place, for Stryker to read', () => {
    const { main, linked } = worktrees();
    write(linked, { '.stryker-tmp/silent': '' });
    expect(firstLine(linked)).toBe(`${SEED}${main})`);
    expect(read(path.join(linked, INCREMENTAL))).toBe(read(path.join(main, INCREMENTAL)));
  });

  it('runs every mutant again when a file differs from the main worktree', () => {
    const { main, linked } = worktrees();
    write(linked, { 'src/age.ts': `${GATE_SOURCE}// on another branch\n` });
    const result = testGates(['mutation', '--dir', linked]);
    const lines = result.stdout.split('\n');
    expect(lines[0]).toBe(`${SEED}${main})`);
    expect(lines[1]).toBe(`${NOTE}${CHANGED}src/age.ts`);
    const args = JSON.parse(read(path.join(linked, '.stryker-tmp/stryker-args.json'))) as string[];
    expect(args).toContain('--force');
  });

  it('runs every mutant when the main worktree has no record, or one of another version', () => {
    const { main, linked } = worktrees();
    fs.rmSync(path.join(main, RECORD));
    expect(testGates(['doctor', '--dir', linked]).stdout).toContain(
      `  this worktree has no record of its own, and the main worktree (${main}) has none this worktree can start from`
    );
    // Stryker writes nothing here, so whatever is there after the run was copied.
    write(linked, { '.stryker-tmp/silent': '' });
    expect(firstLine(linked)).not.toContain('main worktree');
    expect(fs.existsSync(path.join(linked, INCREMENTAL))).toBe(false);

    const other = worktrees();
    const record = JSON.parse(read(path.join(other.main, RECORD))) as { format: number };
    write(other.main, { [RECORD]: { ...record, format: record.format + 1 } });
    const result = testGates(['mutation', '--dir', other.linked]);
    expect(result.stdout.split('\n').slice(0, 2)).toEqual([
      `${SEED}${other.main})`,
      `${NOTE}the record of the last run is not one this version can read`,
    ]);
  });

  it('takes nothing when the incremental file of the main worktree is not the one its record names', () => {
    // As when a run in the main worktree wrote a new incremental file and not yet its record.
    const { main, linked } = worktrees();
    write(main, { [INCREMENTAL]: { written: 'by another run' } });
    expect(testGates(['doctor', '--dir', linked]).stdout).toContain(
      `  this worktree has no record of its own, and the main worktree (${main}) has none this worktree can start from`
    );
    write(linked, { '.stryker-tmp/silent': '' });
    expect(firstLine(linked)).not.toContain('main worktree');
    expect(fs.existsSync(path.join(linked, INCREMENTAL))).toBe(false);
  });

  it('takes nothing from the main worktree in a Stryker sandbox below a linked worktree', () => {
    const { main, linked } = worktrees();
    // The same sandbox in both worktrees, with a record in that of the main worktree.
    const sandbox = '.stryker-tmp/sandbox-1';
    for (const top of [main, linked]) {
      fs.cpSync(path.join(main, 'src'), path.join(top, sandbox, 'src'), { recursive: true });
      for (const file of ['test-gates.json', 'package.json', 'stryker.gates.config.mjs']) {
        fs.copyFileSync(path.join(main, file), path.join(top, sandbox, file));
      }
      fs.cpSync(path.join(linked, 'node_modules'), path.join(top, sandbox, 'node_modules'), {
        recursive: true,
      });
    }
    expect(mutation(path.join(main, sandbox))).toEqual(REUSED);
    expect(fs.existsSync(path.join(main, sandbox, RECORD))).toBe(true);
    expect(testGates(['doctor', '--dir', path.join(linked, sandbox)]).stdout).not.toContain(
      'main worktree'
    );
    write(path.join(linked, sandbox), { '.stryker-tmp/silent': '' });
    expect(firstLine(path.join(linked, sandbox))).not.toContain('main worktree');
    expect(fs.existsSync(path.join(linked, sandbox, INCREMENTAL))).toBe(false);
  });
});
