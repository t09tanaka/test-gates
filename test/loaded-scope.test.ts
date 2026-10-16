import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadedScope, runnerConfigs } from '../src/affected-files';
import { readManifest } from '../src/load';
import { SnapshotError, snapshotOf } from '../src/snapshot';
import { cleanup, project } from './helpers';

afterAll(cleanup);

const H = "import { expect, it } from 'vitest';\n";
// A path that goes up `levels` directories. Put together here, because written out in this
// file it would be a path that leads out of this repository, and the snapshot of this
// repository reads this file too.
const up = (levels: number) => Array.from({ length: levels }, () => '..').join('/');
const OWN_CONFIG =
  "import { createVitestGatesConfig } from '@t09tanaka/test-gates/vitest';\n" +
  "export default createVitestGatesConfig({ setupFiles: ['test/setup.ts'] });\n";

/**
 * A repository with two packages. The subproject `fee-rules` has one gate, whose spec imports a
 * helper; `catalog-site` is a package the subproject does not use.
 */
function repository(files: Record<string, string | object> = {}): string {
  return project({
    'package.json': { name: 'root', private: true, workspaces: ['fee-rules'] },
    'node_modules/vitest/package.json': '{ "name": "vitest" }',
    'node_modules/@t09tanaka/test-gates/package.json': '{ "name": "@t09tanaka/test-gates" }',
    'catalog-site/src/listing.ts': 'export const listing = 1;\n',
    'fee-rules/test-gates.json': {
      gates: [{ path: 'src/fee.ts', decides: 'a fee', impact: 'a wrong fee' }],
      candidates: [],
    },
    'fee-rules/stryker.gates.config.mjs':
      "export default { testRunner: 'vitest', vitest: { configFile: 'vitest.gates.config.ts' } };\n",
    'fee-rules/vitest.gates.config.ts': OWN_CONFIG,
    'fee-rules/test/setup.ts': 'export {};\n',
    'fee-rules/src/fee.ts': 'export const fee = (x: number) => x + 1;\n',
    'fee-rules/src/fee.spec.ts':
      `${H}import { fee } from './fee';\nimport { near } from './near';\n` +
      "it('fee', () => { expect(near(fee(1), 2)).toBe(true); });\n",
    'fee-rules/src/near.ts': 'export const near = (a: number, b: number) => a === b;\n',
    ...files,
  });
}

/** The keys of the snapshot of `fee-rules`, and the files whose paths were followed. */
function snapshot(root: string): { keys: string[]; followed: Set<string> | null } {
  const dir = path.join(root, 'fee-rules');
  let followed: Set<string> | null = null;
  const { snapshot: taken } = snapshotOf({
    dir,
    written: [],
    args: [],
    scope: (listed) => {
      followed = loadedScope(
        readManifest(dir),
        runnerConfigs(dir, 'stryker.gates.config.mjs', {
          testRunner: 'vitest',
          vitestConfig: 'vitest.gates.config.ts',
        }),
        listed
      );
      return followed;
    },
  });
  return { keys: Object.keys(taken.files), followed };
}

const ELSEWHERE = 'catalog-site/src/listing.ts';
// Whether the file system tells the case of letters apart (Linux) or not (macOS, Windows).
const caseInsensitive = (): boolean => {
  const dir = project({ 'probe.txt': '' });
  return fs.existsSync(path.join(dir, 'PROBE.TXT'));
};

describe('the paths the snapshot follows', () => {
  it('follows only what the run loads, and compares every file of the subproject', () => {
    const root = repository({
      // A lint config, an IDE file and a component no gate loads, each with a way up that would
      // otherwise take every file of the repository.
      'fee-rules/eslint.config.js': `export default [{ rules: { 'no-restricted-imports': ['error', { patterns: ['${up(1)}/'] }] } }];\n`,
      'fee-rules/.idea/vcs.xml': `<mapping directory="$PROJECT_DIR$/${up(1)}" vcs="Git" />\n`,
      'fee-rules/src/banner.ts': `export const banner = require('${up(2)}');\n`,
      'fee-rules/package.json': { scripts: { report: `open ${up(1)}/coverage` } },
      // What the compiler is given is not what the run loads.
      'fee-rules/tsconfig.build.json': { files: ['src/banner.ts'], include: ['src'] },
    });
    const { keys, followed } = snapshot(root);
    expect(keys).not.toContain(ELSEWHERE);
    expect(keys).toEqual(
      expect.arrayContaining([
        'fee-rules/eslint.config.js',
        'fee-rules/.idea/vcs.xml',
        'fee-rules/src/banner.ts',
        'fee-rules/package.json',
        'fee-rules/tsconfig.build.json',
      ])
    );
    const shown = [...(followed ?? [])].map((file) => path.relative(root, file)).sort();
    expect(shown).toEqual([
      'fee-rules/src/fee.spec.ts',
      'fee-rules/src/fee.ts',
      'fee-rules/src/near.ts',
      'fee-rules/stryker.gates.config.mjs',
      'fee-rules/test-gates.json',
      'fee-rules/test/setup.ts',
      'fee-rules/tsconfig.build.json',
      'fee-rules/vitest.gates.config.ts',
    ]);
  });

  it.each([
    ['the runner config', 'fee-rules/vitest.gates.config.ts', `${OWN_CONFIG}// '${up(1)}'\n`],
    ['a setup file it names', 'fee-rules/test/setup.ts', `export const top = '${up(1)}';\n`],
    ['what a spec imports', 'fee-rules/src/near.ts', `export const near = '${up(1)}';\n`],
    ['tsconfig.json', 'fee-rules/tsconfig.json', { extends: `${up(1)}/tsconfig.base.json` }],
    [
      'the mock that is taken for a file',
      'fee-rules/src/__mocks__/near.ts',
      `export const near = '${up(1)}';\n`,
    ],
  ])('follows a way up in %s, as before', (_name, file, content) => {
    const root = repository({ [file]: content });
    expect(snapshot(root).keys).toContain(ELSEWHERE);
  });

  it.each([
    ['without its extension', '@shared/money/near', 'fee-rules/lib/money/near.ts'],
    ['with its extension', '@shared/money/near.js', 'fee-rules/lib/money/near.js'],
    ['to an index file', '@shared/money', 'fee-rules/lib/money/index.ts'],
  ])('follows what an alias the settings do not name leads to, %s', (_name, specifier, file) => {
    const root = repository({
      'fee-rules/src/fee.spec.ts':
        `${H}import { fee } from './fee';\nimport { near } from '${specifier}';\n` +
        "it('fee', () => { expect(near(fee(1), 2)).toBe(true); });\n",
      [file]: `export const near = '${up(3)}';\n`,
    });
    const { keys, followed } = snapshot(root);
    expect(followed).not.toBeNull();
    expect(keys).toContain(ELSEWHERE);
  });

  it.each([
    [
      'an import of an alias with the extension of the compiled file',
      { 'fee-rules/src/near.ts': "export { near } from '@shared/helper.js';\n" },
      'fee-rules/lib/helper.ts',
    ],
    [
      'an import of an alias of one part',
      { 'fee-rules/src/near.ts': "export { near } from '#helper';\n" },
      'fee-rules/lib/helper.ts',
    ],
    ['a mock of a scoped package in the root __mocks__', {}, 'fee-rules/__mocks__/@acme/kit.ts'],
    [
      'a config that tsconfig.json extends',
      { 'fee-rules/tsconfig.json': { extends: './config/tsconfig.shared.json' } },
      'fee-rules/config/tsconfig.shared.json',
    ],
    [
      'a plugin that .babelrc names',
      { 'fee-rules/.babelrc': { plugins: [['./babel/plugin.js', { loose: true }]] } },
      'fee-rules/babel/plugin.js',
    ],
    [
      'a config that a tsconfig.json with comments extends',
      {
        'fee-rules/tsconfig.json':
          '{\n  // shared\n  "extends": "./config/base.json", /* and */\n  "include": ["src"],\n}\n',
      },
      'fee-rules/config/base.json',
    ],
  ])('follows a way up in the file that %s leads to', (_name, files, file) => {
    const root = repository({
      ...files,
      [file]: `export const near = (a: number, b: number) => a === b;\nexport const top = '${up(file.split('/').length - 1)}';\n`,
    });
    expect(snapshot(root).keys).toContain(ELSEWHERE);
  });

  it.each([
    [
      'inside defineConfig, with another config spread into its options',
      "import { defineConfig } from 'vitest/config';\nimport { createVitestGatesConfig } from '@t09tanaka/test-gates/vitest';\nimport base from './vitest.base';\nexport default defineConfig(createVitestGatesConfig({ ...base, test: { ...base.test } }));\n",
    ],
    [
      'after a comment that holds a glob',
      "// The specs are src/*.spec.ts\nconst { createJestGatesConfig } = require('@t09tanaka/test-gates/jest');\n/** @type {import('jest').Config} */\nmodule.exports = createJestGatesConfig({});\n",
    ],
    [
      'imported under another name',
      "const { createVitestGatesConfig: gates } = require('@t09tanaka/test-gates/vitest');\nmodule.exports = gates({});\n",
    ],
    [
      'kept in a variable that is exported as it is',
      "import { createVitestGatesConfig } from '@t09tanaka/test-gates/vitest';\nconst config = createVitestGatesConfig({});\nexport default config;\n",
    ],
  ])(
    'narrows the search for a runner config that is what the helper returns, %s',
    (_name, config) => {
      const root = repository({
        'fee-rules/vitest.gates.config.ts': config,
        'fee-rules/vitest.base.ts': "export default { test: { include: ['src/**/*.test.ts'] } };\n",
        'fee-rules/eslint.config.js': `export default '${up(1)}';\n`,
      });
      const { keys, followed } = snapshot(root);
      expect(followed).not.toBeNull();
      expect(keys).not.toContain(ELSEWHERE);
    }
  );

  // Elsewhere the import leads to no file, for the run as well.
  it.runIf(caseInsensitive())(
    'follows a way up in a file imported in another case of letters than it has',
    () => {
      const root = repository({
        'fee-rules/src/near.ts': "export { near } from './Helper';\n",
        'fee-rules/src/helper.ts': `export const near = (a: number, b: number) => a === b;\nexport const top = '${up(2)}';\n`,
      });
      expect(snapshot(root).keys).toContain(ELSEWHERE);
    }
  );

  it.each([
    [
      'a runner config this tool did not make',
      { 'fee-rules/vitest.gates.config.ts': 'export default { test: {} };\n' },
    ],
    [
      'a runner config that is given projects of its own',
      {
        'fee-rules/vitest.gates.config.ts':
          "import { createVitestGatesConfig } from '@t09tanaka/test-gates/vitest';\nexport default createVitestGatesConfig({ test: { projects: ['packages/*'] } });\n",
      },
    ],
    [
      'a runner config merged with another one after the helper',
      {
        'fee-rules/vitest.gates.config.ts':
          "import { mergeConfig } from 'vitest/config';\nimport { createVitestGatesConfig } from '@t09tanaka/test-gates/vitest';\nimport shared from './vitest.shared';\nexport default mergeConfig(createVitestGatesConfig(), shared);\n",
        'fee-rules/vitest.shared.ts': 'export default {};\n',
      },
    ],
    [
      'a runner config put together from a file that names specs',
      {
        'fee-rules/vitest.gates.config.ts':
          "import { createVitestGatesConfig } from '@t09tanaka/test-gates/vitest';\nimport shared from './vitest.shared';\nexport default { ...createVitestGatesConfig(), ...shared };\n",
        'fee-rules/vitest.shared.ts':
          "export default { test: { include: ['src/**/*.test.ts'] } };\n",
      },
    ],
    [
      'a runner config that changes what the helper returns',
      {
        'fee-rules/vitest.gates.config.ts':
          "import { createVitestGatesConfig } from '@t09tanaka/test-gates/vitest';\nconst config = createVitestGatesConfig({});\nconfig.test.include = ['src/**/*.test.ts'];\nexport default config;\n",
      },
    ],
    [
      'an import whose path is not written out',
      { 'fee-rules/src/near.ts': 'export const near = (name: string) => import(name);\n' },
    ],
  ])('follows every file with %s', (_name, files) => {
    const root = repository({
      ...files,
      'fee-rules/eslint.config.js': `export default '${up(1)}';\n`,
    });
    const { keys, followed } = snapshot(root);
    expect(followed).toBeNull();
    expect(keys).toContain(ELSEWHERE);
  });
});

describe('a path outside of what can be listed', () => {
  // `fee-rules/../../x` from a file at the top of the subproject: above the repository.
  const outside = `${up(2)}/no-such-sibling-of-the-repository`;

  it('is compared as missing while nothing is there', () => {
    const root = repository({
      'fee-rules/vitest.gates.config.ts': `${OWN_CONFIG}const sandbox = require('path').resolve(__dirname, '${outside}');\n`,
    });
    const { keys } = snapshot(root);
    expect(keys).toContain(`${up(1)}/no-such-sibling-of-the-repository`);
    expect(keys).not.toContain(ELSEWHERE);
  });

  it('is refused once something is there', () => {
    const sibling = path.basename(project({ 'kit.ts': 'export {};\n' }));
    const root = repository({
      'fee-rules/vitest.gates.config.ts': `${OWN_CONFIG}const kit = require('path').resolve(__dirname, '${up(2)}/${sibling}');\n`,
    });
    expect(() => snapshot(root)).toThrow(SnapshotError);
  });
});
