import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { AffectedError, affectedInputs, runnerConfigs } from '../src/affected-files';
import { decideReuse } from '../src/commands/mutation';
import { readManifest } from '../src/load';
import { snapshotOf } from '../src/snapshot';
import { cleanup, project, write } from './helpers';

afterAll(cleanup);

const gate = (file: string) => ({ path: file, decides: 'a price', impact: 'a wrong price' });
const H = "import { expect, it } from 'vitest';\n";

/**
 * Three gates: a and b share a helper, the spec of b checks through a, c stands alone.
 * A config for Vitest that names a setup file.
 */
function fixture(extra: Record<string, string | object> = {}, manifest: object = {}): string {
  return project({
    'package.json': { name: 'fixture', private: true, type: 'module' },
    'test-gates.json': {
      gates: [gate('src/a.ts'), gate('src/b.ts'), gate('src/c.ts')],
      candidates: [],
      ...manifest,
    },
    'stryker.gates.config.mjs':
      "export default { testRunner: 'vitest', vitest: { configFile: 'vitest.gates.config.ts' } };\n",
    'vitest.gates.config.ts':
      "export default { test: { setupFiles: ['./test/setup.ts'] }, root: import.meta.dirname };\n",
    'test/setup.ts': "import { prepare } from './prepare';\nprepare();\n",
    'test/prepare.ts': 'export const prepare = () => undefined;\n',
    'src/round.ts': 'export const round = (x: number) => Math.round(x);\n',
    'src/a.ts': "import { round } from './round';\nexport const a = (x: number) => round(x) + 1;\n",
    'src/b.ts':
      "import { round } from './round.js';\nexport const b = (x: number) => round(x) * 2;\n",
    'src/c.ts': 'export const c = (x: number) => x - 1;\n',
    'src/a.spec.ts': `${H}import { a } from './a';\nit('a', () => { expect(a(1)).toBe(2); });\n`,
    'src/b.spec.ts':
      `${H}import { b } from './b';\nimport { a } from './a';\n` +
      "it('b', () => { expect(a(b(1))).toBe(3); });\n",
    'src/c.spec.ts': `${H}import { c } from './c';\nit('c', () => { expect(c(1)).toBe(0); });\n`,
    'src/unrelated.ts': 'export const x = 1;\n',
    'node_modules/vitest/package.json': '{ "name": "vitest" }',
    ...extra,
  });
}

function inputs(dir: string, covering: Record<string, string[]> = {}, tests: string[] = []) {
  const { snapshot, root } = snapshotOf({ dir, written: ['reports'], args: [] });
  const manifest = readManifest(dir);
  const configs = runnerConfigs(dir, 'stryker.gates.config.mjs', {
    testRunner: 'vitest',
    vitestConfig: 'vitest.gates.config.ts',
  });
  return affectedInputs(manifest, { root, files: snapshot.files, configs, tests, covering });
}

/** Gate c loads src/settings.ts, which a test writes. */
const LOADS_SETTINGS = {
  'src/c.ts':
    "import { env } from './settings';\nexport const c = (x: number) => (env ? x - 1 : x);\n",
  'src/settings.ts': 'export const env = 1;\n',
};

const refusal = (dir: string): string => {
  try {
    inputs(dir);
  } catch (error) {
    expect(error).toBeInstanceOf(AffectedError);
    return (error as Error).message;
  }
  throw new Error('no refusal');
};

describe('affectedInputs', () => {
  it('finds for each gate its specs, the specs that import it, and what they import', () => {
    const found = inputs(fixture());
    expect(found.subproject).toBe('');
    expect(found.gates['src/a.ts']).toEqual({
      key: 'src/a.ts',
      specs: ['src/a.spec.ts', 'src/b.spec.ts'],
      files: ['src/a.spec.ts', 'src/a.ts', 'src/b.spec.ts', 'src/b.ts', 'src/round.ts'],
    });
    expect(found.gates['src/b.ts']?.files).toEqual([
      'src/a.ts',
      'src/b.spec.ts',
      'src/b.ts',
      'src/round.ts',
    ]);
    expect(found.gates['src/c.ts']?.files).toEqual(['src/c.spec.ts', 'src/c.ts']);
    // the configs, and the setup file they name with what it imports
    expect(found.config).toEqual([
      'stryker.gates.config.mjs',
      'test/prepare.ts',
      'test/setup.ts',
      'vitest.gates.config.ts',
    ]);
  });

  it('adds the specs that covered a gate, and takes the spec files of the last run', () => {
    const dir = fixture({
      'src/extra.spec.ts': `${H}import { c } from './c';\nit('c', () => {});\n`,
    });
    const found = inputs(dir, { 'src/a.ts': ['src/c.spec.ts'] }, ['src/extra.spec.ts']);
    expect(found.gates['src/a.ts']?.specs).toEqual([
      'src/a.spec.ts',
      'src/b.spec.ts',
      'src/c.spec.ts',
    ]);
    expect(found.gates['src/c.ts']?.specs).toEqual(['src/c.spec.ts', 'src/extra.spec.ts']);
  });

  it('keys the files by the root of what is compared, for a subproject of a repository', () => {
    const root = project({
      'package.json': { name: 'root', private: true, workspaces: ['pkg'] },
      'node_modules/vitest/package.json': '{ "name": "vitest" }',
    });
    const dir = path.join(root, 'pkg');
    write(dir, {
      'test-gates.json': { gates: [gate('src/c.ts')], candidates: [] },
      'stryker.gates.config.mjs': "export default { testRunner: 'vitest' };\n",
      'vitest.config.ts': 'export default {};\n',
      'src/c.ts': "import { money } from '../../shared/money';\nexport const c = money;\n",
      'src/c.spec.ts': `${H}import { c } from './c';\nit('c', () => { expect(c).toBe(1); });\n`,
    });
    write(root, { 'shared/money.ts': 'export const money = 1;\n' });
    const { snapshot, root: listed } = snapshotOf({ dir, written: [], args: [] });
    const found = affectedInputs(readManifest(dir), {
      root: listed,
      files: snapshot.files,
      configs: runnerConfigs(dir, 'stryker.gates.config.mjs', { testRunner: 'vitest' }),
      tests: [],
      covering: {},
    });
    expect(found.subproject).toBe('pkg');
    expect(found.gates['src/c.ts']).toEqual({
      key: 'pkg/src/c.ts',
      specs: ['src/c.spec.ts'],
      files: ['pkg/src/c.spec.ts', 'pkg/src/c.ts', 'shared/money.ts'],
    });
    expect(found.config).toEqual(['pkg/stryker.gates.config.mjs', 'pkg/vitest.config.ts']);
  });

  it('follows data, snapshots, aliases and paths handed to the runner', () => {
    const dir = fixture(
      {
        'src/c.spec.ts':
          `${H}import { c } from '@/c';\nimport rates from './rates.json';\n` +
          "vi.mock('./mocked', () => ({}));\n" +
          "it('c', () => { expect(c(rates.one)).toMatchSnapshot(); });\n",
        'src/rates.json': '{ "one": 1 }\n',
        'src/mocked.ts': 'export const m = 1;\n',
        'src/__snapshots__/c.spec.ts.snap': 'exports[`c 1`] = `0`;\n',
      },
      { settings: { importAliases: [{ prefix: '@/', target: 'src/' }] } }
    );
    expect(inputs(dir).gates['src/c.ts']?.files).toEqual([
      'src/__snapshots__/c.spec.ts.snap',
      'src/c.spec.ts',
      'src/c.ts',
      'src/mocked.ts',
      'src/rates.json',
    ]);
  });

  it.each([
    ['an alias', "import { Schema } from '@/types/schema';", 'src/types/schema.d.ts'],
    ['an alias of a directory', "import { Schema } from '@/types';", 'src/types/index.d.ts'],
    ['a relative path', "import { Schema } from './types/schema';", 'src/types/schema.d.ts'],
    ['a path with .js', "import { Schema } from './types/schema.js';", 'src/types/schema.d.ts'],
  ])('follows %s that leads to a declaration file', (_name, line, declaration) => {
    const dir = fixture(
      {
        'src/c.ts': `${line}\nexport const c = (x: number): Schema => x - 1;\n`,
        [declaration]: 'export type Schema = number;\n',
      },
      { settings: { importAliases: [{ prefix: '@/', target: 'src/' }] } }
    );
    expect(inputs(dir).gates['src/c.ts']?.files).toEqual([
      'src/c.spec.ts',
      'src/c.ts',
      declaration,
    ]);
  });

  it('takes a script over a declaration file of the same name', () => {
    const dir = fixture({
      'src/c.ts': "import { rate } from './rate';\nexport const c = (x: number) => x - rate;\n",
      'src/rate.js': 'export const rate = 1;\n',
      'src/rate.d.ts': 'export declare const rate: number;\n',
    });
    expect(inputs(dir).gates['src/c.ts']?.files).toEqual([
      'src/c.spec.ts',
      'src/c.ts',
      'src/rate.js',
    ]);
  });

  it.each([
    ['without an extension', './rate'],
    ['with .js', './rate.js'],
  ])('follows a script and a TypeScript file of one name, imported %s', (_name, specifier) => {
    // Vite takes rate.js first, the TypeScript compiler rate.ts: either may be the one loaded.
    const dir = fixture({
      'src/c.ts': `import { rate } from '${specifier}';\nexport const c = (x: number) => x - rate;\n`,
      'src/rate.ts': 'export const rate: number = 1;\n',
      'src/rate.js': 'export const rate = 1;\n',
    });
    expect(inputs(dir).gates['src/c.ts']?.files).toEqual([
      'src/c.spec.ts',
      'src/c.ts',
      'src/rate.js',
      'src/rate.ts',
    ]);
  });

  it('takes a spec of the last run that is gone for itself', () => {
    const found = inputs(fixture(), { 'src/c.ts': ['src/gone.spec.ts'] });
    expect(found.gates['src/c.ts']?.files).toEqual([
      'src/c.spec.ts',
      'src/c.ts',
      'src/gone.spec.ts',
    ]);
  });

  it.each([
    [
      'a computed import',
      { 'src/a.spec.ts': `${H}const name = './a';\nawait import(name);\nit('a', () => {});\n` },
      'src/a.spec.ts:3 imports a module whose path is not written out',
    ],
    [
      'a require with a variable',
      { 'src/round.ts': 'const name = "x";\nrequire(name);\nexport const round = 1;\n' },
      'src/round.ts:2 imports a module whose path is not written out',
    ],
    [
      'an import put together from strings',
      {
        'src/round.ts':
          "export const round = async (lang: string) => import('./locales/' + lang + '.ts');\n",
      },
      'src/round.ts:1 imports a module whose path is not written out',
    ],
    [
      'a require put together from strings',
      { 'src/round.ts': "export const round = (lang: string) => require('./rules/' + lang);\n" },
      'src/round.ts:1 imports a module whose path is not written out',
    ],
    [
      'an import from a template with a value in it',
      {
        'src/round.ts':
          'export const round = async (lang: string) => import(`./locales/${lang}`);\n',
      },
      'src/round.ts:1 imports a module whose path is not written out',
    ],
    [
      'a file read by a path from __dirname',
      {
        'src/settings.ts': `import { join } from 'node:path';\nexport const env = readFileSync(join(__dirname, '..', '.env'));\n`,
      },
      'src/settings.ts uses readFileSync, which can reach files that no import names',
    ],
    [
      'a path from __dirname handed to a package',
      {
        'src/settings.ts':
          "import { join } from 'node:path';\nimport { config } from 'dotenv';\n" +
          "config({ path: join(__dirname, '..', '.env') });\nexport const env = 1;\n",
        'node_modules/dotenv/package.json': '{ "name": "dotenv" }',
      },
      'src/settings.ts uses __dirname and imports dotenv, which can read files by it that no import names',
    ],
    [
      'a file looked at by a path from import.meta.dirname',
      {
        'src/settings.ts': `export const has = existsSync(\`\${import.meta.dirname}/.env\`);\n`,
      },
      'src/settings.ts uses import.meta.dirname and existsSync, which can reach files that no import names',
    ],
    [
      'a file streamed by a path from import.meta.url',
      {
        'src/settings.ts':
          "export const s = createReadStream(new URL('./x.csv', import.meta.url));\n",
      },
      'src/settings.ts uses import.meta.url and createReadStream, which can reach files that no import names',
    ],
    [
      'a mock named by a path from __dirname',
      {
        'src/settings.ts':
          "import { vi } from 'vitest';\nimport { join } from 'node:path';\n" +
          "vi.mock(\n  join(__dirname, 'rates')\n);\nexport const env = 1;\n",
      },
      'src/settings.ts uses __dirname and mock, which can reach files that no import names',
    ],
    [
      'a mock named by a template from __dirname',
      {
        'src/settings.ts':
          "import { vi } from 'vitest';\nvi.mock(`${__dirname}/rates`);\nexport const env = 1;\n",
      },
      'src/settings.ts imports ${__dirname}/rates, which is neither a file nor an installed package (name an alias in settings.importAliases)',
    ],
    [
      'a file read with fs',
      {
        'src/c.spec.ts': `${H}import { readFileSync } from 'node:fs';\nimport { c } from './c';\n`,
      },
      'src/c.spec.ts uses readFileSync, which can reach files that no import names',
    ],
    [
      'fs imported under another name',
      { 'src/c.spec.ts': `${H}import * as files from 'fs/promises';\nimport { c } from './c';\n` },
      'src/c.spec.ts imports fs/promises, which can reach files that no import names',
    ],
    [
      'an import that leads to no file',
      { 'src/c.spec.ts': `${H}import { c } from './missing';\n` },
      'src/c.spec.ts imports ./missing, which leads to no file',
    ],
    [
      'an alias handed to createMockFromModule with a type argument',
      {
        'src/c.spec.ts': `${H}import { c } from './c';\nconst kit = jest.createMockFromModule<typeof c>('@/kit');\n`,
      },
      'src/c.spec.ts imports @/kit, which is neither a file nor an installed package (name an alias in settings.importAliases)',
    ],
    [
      'an alias that is not named',
      { 'src/c.spec.ts': `${H}import { c } from '@/c';\n` },
      'src/c.spec.ts imports @/c, which is neither a file nor an installed package (name an alias in settings.importAliases)',
    ],
    [
      'an absolute import that leads to no file',
      { 'src/c.spec.ts': `${H}import { c } from '/no/such/file';\n` },
      'src/c.spec.ts imports /no/such/file, which leads to no file',
    ],
  ])('refuses %s', (_name, files, message) => {
    expect(refusal(fixture({ ...LOADS_SETTINGS, ...files }))).toBe(message);
  });

  it.each([
    ['__dirname', "export const env = join(__dirname, '..', '.env');\n"],
    ['__filename', 'export const env = `${__filename}.env`;\n'],
    ['import.meta.dirname', "export const env = join(import.meta.dirname, '..', '.env');\n"],
    ['import.meta.filename', 'export const env = `${import.meta.filename}.env`;\n'],
    [
      'import.meta.url',
      "import { fileURLToPath } from 'node:url';\nexport const env = fileURLToPath(new URL('../.env', import.meta.url));\n",
    ],
  ])('takes a file that only finds where it lies with %s', (_name, settings) => {
    const dir = fixture({
      ...LOADS_SETTINGS,
      'src/settings.ts': `import { join } from 'node:path';\n${settings}`,
      'src/c.spec.ts': `${H}import { c } from './c';\nconst here = __dirname;\nit('c', () => {});\n`,
    });
    expect(inputs(dir).gates['src/c.ts']?.files).toEqual([
      'src/c.spec.ts',
      'src/c.ts',
      'src/settings.ts',
    ]);
  });

  it.each([['/abs/x.spec.ts'], ['../x.spec.ts']])(
    'refuses a spec of the report that is not in the subproject: %s',
    (file) => {
      expect(() => inputs(fixture(), {}, [file])).toThrow(
        new AffectedError(`the report names a spec file outside of the subproject: ${file}`)
      );
      expect(() => inputs(fixture(), { 'src/c.ts': [file] })).toThrow(AffectedError);
    }
  );

  it('refuses a file outside of what is compared', () => {
    const outside = project({ 'helper.ts': 'export const h = 1;\n' });
    const dir = fixture({
      'src/c.spec.ts': `${H}import { h } from ${JSON.stringify(path.join(outside, 'helper.ts'))};\n`,
    });
    expect(refusal(dir)).toBe(
      `${path.join(outside, 'helper.ts')} is outside of the files that are compared`
    );
  });

  it('refuses a file that is loaded but not compared', () => {
    const dir = fixture({
      'src/c.spec.ts': `${H}import { c } from './c';\nimport './generated';\n`,
    });
    write(dir, { 'src/generated.ts': 'export {};\n' });
    const { snapshot, root } = snapshotOf({ dir, written: [], args: [] });
    delete snapshot.files['src/generated.ts'];
    expect(() =>
      affectedInputs(readManifest(dir), {
        root,
        files: snapshot.files,
        configs: { files: [] },
        tests: [],
        covering: {},
      })
    ).toThrow(
      new AffectedError(
        'src/generated.ts is loaded by a gate or a spec, but is not among the compared files (does git ignore it?)'
      )
    );
  });

  it('refuses a gate that a setup file loads for every spec', () => {
    const dir = fixture({ 'test/setup.ts': "import { c } from '../src/c';\nc(1);\n" });
    expect(refusal(dir)).toBe(
      'src/c.ts is loaded through the test runner config for every spec (test/setup.ts)'
    );
  });

  it('refuses a setup file that reads files', () => {
    const dir = fixture({ 'test/setup.ts': "import fs from 'node:fs';\nfs.existsSync('x');\n" });
    expect(refusal(dir)).toBe(
      'test/setup.ts imports node:fs, which can reach files that no import names'
    );
  });

  it.each([
    [
      'Vue',
      'src/Widget.vue',
      '<template><p /></template>\n<script setup lang="ts">\nimport { format } from \'./format\';\n</script>\n',
    ],
    [
      'Astro',
      'src/Widget.astro',
      "---\nimport { format } from './format';\n---\n<p>{format(1)}</p>\n",
    ],
  ])(
    'refuses a %s component a spec loads: it can use others it does not import',
    (_name, file, source) => {
      const dir = fixture({
        'src/a.spec.ts': `${H}import { a } from './a';\nimport Widget from './${file.slice(4)}';\nit('a', () => { expect(a(1) && Widget).toBeTruthy(); });\n`,
        [file]: source,
        'src/format.ts': 'export const format = (x: number) => String(x);\n',
      });
      expect(refusal(dir)).toBe(
        `${file} is a component, which can use others that it does not import`
      );
    }
  );

  it('takes a component or data a runner config names as a config, not as a setup file', () => {
    const dir = fixture({
      'vitest.gates.config.ts':
        "export default { test: { setupFiles: ['./test/setup.ts'], coverage: { exclude: ['src/components/Widget.vue', 'src/data/rates.json'] } }, root: import.meta.dirname };\n",
      'src/components/Widget.vue':
        '<template><p /></template>\n<script setup lang="ts">\nimport { format } from \'../format\';\n</script>\n',
      'src/format.ts': 'export const format = (x: number) => String(x);\n',
      'src/data/rates.json': '{ "one": 1 }\n',
    });
    const found = inputs(dir);
    // the setup file is still taken, with what it imports
    expect(found.config).toEqual([
      'src/components/Widget.vue',
      'src/data/rates.json',
      'stryker.gates.config.mjs',
      'test/prepare.ts',
      'test/setup.ts',
      'vitest.gates.config.ts',
    ]);
    expect(found.gates['src/c.ts']?.files).toEqual(['src/c.spec.ts', 'src/c.ts']);
  });

  it('refuses a package of the repository that is linked into node_modules', () => {
    const dir = fixture({
      'src/a.ts':
        "import { round } from '@acme/shared';\nexport const a = (x: number) => round(x) + 1;\n",
      'packages/shared/index.ts': 'export const round = (x: number) => Math.round(x);\n',
    });
    fs.mkdirSync(path.join(dir, 'node_modules/@acme'), { recursive: true });
    fs.symlinkSync(path.join(dir, 'packages/shared'), path.join(dir, 'node_modules/@acme/shared'));
    expect(refusal(dir)).toBe(
      'src/a.ts imports @acme/shared, a package of the repository linked into node_modules'
    );
  });

  it('takes an installed package for what the lock file says it is', () => {
    const dir = fixture({
      'src/a.ts':
        "import { round } from '@acme/shared';\nexport const a = (x: number) => round(x) + 1;\n",
      'node_modules/@acme/shared/index.js': 'exports.round = Math.round;\n',
    });
    expect(inputs(dir).gates['src/a.ts']?.files).not.toContain(
      'node_modules/@acme/shared/index.js'
    );
  });

  it('does not take a spec or a gate the config names for a file of every spec', () => {
    const dir = fixture({
      'vitest.gates.config.ts':
        "export default { test: { include: ['src/a.spec.ts', 'src/c.ts'] }, root: __dirname };\n",
    });
    expect(inputs(dir).config).toEqual(['stryker.gates.config.mjs', 'vitest.gates.config.ts']);
  });

  it('looks again on disk in the next run for a file that was not there', () => {
    const dir = fixture({
      'src/c.ts': "import { rate } from './rate';\nexport const c = (x: number) => x - rate;\n",
    });
    expect(refusal(dir)).toBe('src/c.ts imports ./rate, which leads to no file');
    write(dir, { 'src/rate.ts': 'export const rate = 1;\n' });
    expect(inputs(dir).gates['src/c.ts']?.files).toEqual([
      'src/c.spec.ts',
      'src/c.ts',
      'src/rate.ts',
    ]);
  });

  it('ignores a package and a builtin', () => {
    const dir = fixture({
      'node_modules/money-kit/package.json': '{ "name": "money-kit" }',
      'src/c.ts':
        "import { add } from 'money-kit';\nimport { EOL } from 'node:os';\nimport path from 'path';\nexport const c = (x: number) => add(x, -1) + EOL.length + path.sep.length;\n",
    });
    expect(inputs(dir).gates['src/c.ts']?.files).toEqual(['src/c.spec.ts', 'src/c.ts']);
  });
});

describe('a JSON file required without its extension', () => {
  it('follows it as data, as Jest and Vite do', () => {
    const dir = fixture({
      'src/c.ts':
        "const rates = require('./rates');\nexport const c = (x: number) => x - rates.one;\n",
      'src/rates.json': '{ "one": 1 }\n',
    });
    expect(inputs(dir).gates['src/c.ts']?.files).toEqual([
      'src/c.spec.ts',
      'src/c.ts',
      'src/rates.json',
    ]);
  });

  it('takes a script of the same name first, and both when both are there', () => {
    const dir = fixture({
      'src/c.ts': "import { one } from './rates';\nexport const c = (x: number) => x - one;\n",
      'src/rates.ts': 'export const one = 1;\n',
      'src/rates.json': '{ "one": 1 }\n',
    });
    expect(inputs(dir).gates['src/c.ts']?.files).toEqual([
      'src/c.spec.ts',
      'src/c.ts',
      'src/rates.json',
      'src/rates.ts',
    ]);
  });

  it('follows the index.json of a directory', () => {
    const dir = fixture({
      'src/c.ts':
        "const rates = require('./rates');\nexport const c = (x: number) => x - rates.one;\n",
      'src/rates/index.json': '{ "one": 1 }\n',
    });
    expect(inputs(dir).gates['src/c.ts']?.files).toEqual([
      'src/c.spec.ts',
      'src/c.ts',
      'src/rates/index.json',
    ]);
  });
});

describe('comments', () => {
  it('ignores an import in a comment that leads to no file', () => {
    const dir = fixture({
      'src/c.ts':
        "/* Moved here from:\nimport { c } from './old/c';\n*/\n// import { d } from './old/d';\nexport const c = (x: number) => x - 1;\n",
    });
    expect(inputs(dir).gates['src/c.ts']?.files).toEqual(['src/c.spec.ts', 'src/c.ts']);
  });

  it('ignores the name of a function that reads files in a comment', () => {
    const dir = fixture({
      'src/c.ts':
        '// Pure: no readFileSync, no __dirname here.\n/** Not import.meta.glob either. */\nexport const c = (x: number) => x - 1;\n',
    });
    expect(inputs(dir).gates['src/c.ts']?.files).toEqual(['src/c.spec.ts', 'src/c.ts']);
  });

  it('keeps an import and a path in a string', () => {
    const dir = fixture({
      'src/c.ts':
        "export const hint = 'see // the docs';\nexport const c = (x: number) => (require('./rate') as number) - x;\n" +
        "export const docs = './README.md';\n",
      'src/rate.ts': 'export = 1;\n',
      'src/README.md': 'docs\n',
    });
    expect(inputs(dir).gates['src/c.ts']?.files).toEqual([
      'src/README.md',
      'src/c.spec.ts',
      'src/c.ts',
      'src/rate.ts',
    ]);
  });

  it('gives the line of an import after a comment of several lines', () => {
    const dir = fixture({
      'src/c.ts':
        "/*\n * one\n * two\n */\nexport const c = (lang: string) => require('./rules/' + lang);\n",
    });
    expect(refusal(dir)).toBe('src/c.ts:5 imports a module whose path is not written out');
  });

  it.each([
    [
      'a regular expression with //',
      "const url = /https?:\\/\\//; const r = require('./missing');\n",
    ],
    [
      'a regular expression with /*',
      "const trim = (s: string) => s.replace(/\\/*$/, '');\nimport { x } from './missing';\n",
    ],
    [
      'a regular expression after return',
      "function f(s: string) { return /\\/*$/.test(s); }\nimport { x } from './missing';\n",
    ],
    [
      'a template of several lines with /*',
      "const glob = `\n  src/*\n`;\nimport { x } from './missing';\n/* */\n",
    ],
    ['a string with //', "const u = 'http://x'; const r = require('./missing');\n"],
    ['a comment between two words', "import/* the rate */x from './missing';\n"],
  ])('does not take %s for the start of a comment', (_name, source) => {
    const dir = fixture({ 'src/c.ts': `${source}export const c = (x: number) => x - 1;\n` });
    expect(refusal(dir)).toBe('src/c.ts imports ./missing, which leads to no file');
  });

  it.each([
    [
      'a regular expression with /* after a word that divides',
      "const n = (s: string) => (s.length) /\\/*/.exec(s)?.length;\nexport const c = () => readFileSync('x');\n/* */\n",
    ],
    [
      'a divide before a string with //',
      "const half = (s: string) => s.length / 2 + '/' + '//x'; export const c = () => readFileSync('x');\n",
    ],
    [
      'a URL in the text of JSX',
      'export const Link = () => <a href="/x">https://example.com</a>; export const c = () => readFileSync(\'x\');\n',
    ],
  ])('keeps what follows %s', (_name, source) => {
    const dir = fixture({ 'src/c.ts': source });
    expect(refusal(dir)).toBe(
      'src/c.ts uses readFileSync, which can reach files that no import names'
    );
  });

  it('still takes out a comment after a /', () => {
    const dir = fixture({
      'src/c.ts':
        'export const c = (x: number) => x / 2; // readFileSync is not used\nexport const d = (x: number) => x / 2 /* nor readFileSync */;\nexport const e = (url: string) => url; // see https://example.com, readFileSync\n',
    });
    expect(inputs(dir).gates['src/c.ts']?.files).toEqual(['src/c.spec.ts', 'src/c.ts']);
  });

  it('does not take a regular expression for the start of a comment before readFileSync', () => {
    const dir = fixture({
      'src/c.ts':
        "const strip = (s: string) => s.replace(/\\/*/g, '');\nexport const c = () => readFileSync('x');\n/* */\n",
    });
    expect(refusal(dir)).toBe(
      'src/c.ts uses readFileSync, which can reach files that no import names'
    );
  });
});

describe('a mock in a __mocks__ next to a module', () => {
  it('is loaded with the module, by the gates that load the module', () => {
    const dir = fixture({
      'src/__mocks__/round.ts':
        "import { half } from '../half';\nexport const round = (x: number) => half(x);\n",
      'src/half.ts': 'export const half = (x: number) => x / 2;\n',
    });
    const found = inputs(dir);
    expect(found.gates['src/a.ts']?.files).toEqual([
      'src/__mocks__/round.ts',
      'src/a.spec.ts',
      'src/a.ts',
      'src/b.spec.ts',
      'src/b.ts',
      'src/half.ts',
      'src/round.ts',
    ]);
    expect(found.gates['src/c.ts']?.files).toEqual(['src/c.spec.ts', 'src/c.ts']);
    expect(found.config).not.toContain('src/__mocks__/round.ts');
  });

  it('is loaded also when it has another extension', () => {
    const dir = fixture({ 'src/__mocks__/round.js': 'export const round = () => 0;\n' });
    expect(inputs(dir).gates['src/a.ts']?.files).toContain('src/__mocks__/round.js');
  });

  it.each([
    ['an installed package', 'src/__mocks__/vitest.ts'],
    ['a scoped package', 'src/__mocks__/@acme/kit.ts'],
    ['a builtin module', 'src/__mocks__/fs.ts'],
  ])('is a config when it is named as %s', (_name, file) => {
    const dir = fixture({
      [file]: 'export const x = 1;\n',
      'node_modules/@acme/kit/package.json': '{ "name": "@acme/kit" }',
    });
    expect(inputs(dir).config).toContain(file);
  });

  it('is not a config when it is named as no package', () => {
    const dir = fixture({ 'src/__mocks__/helpers.ts': 'export const x = 1;\n' });
    expect(inputs(dir).config).not.toContain('src/__mocks__/helpers.ts');
  });
});

describe('the module maps of the runner config', () => {
  const ALIASES = { settings: { importAliases: [{ prefix: '@/', target: 'src/' }] } };
  const vitest = (resolve: string) =>
    "import path from 'node:path';\nimport { fileURLToPath } from 'node:url';\n" +
    `export default { resolve: ${resolve}, test: { setupFiles: ['./test/setup.ts'] }, root: import.meta.dirname };\n`;
  /** The files of gate c, or why they cannot be told, with a config of `runner`. */
  const told = (
    files: Record<string, string | object>,
    manifest: object = ALIASES,
    runner: 'jest' | 'vitest' = 'vitest'
  ): string[] | string => {
    const dir = fixture(files, manifest);
    const { snapshot, root } = snapshotOf({ dir, written: ['reports'], args: [] });
    const configs = runnerConfigs(dir, 'stryker.gates.config.mjs', {
      testRunner: runner,
      ...(runner === 'vitest' ? { vitestConfig: 'vitest.gates.config.ts' } : {}),
    });
    try {
      const found = affectedInputs(readManifest(dir), {
        root,
        files: snapshot.files,
        configs,
        tests: [],
        covering: {},
      });
      return found.gates['src/c.ts']?.files ?? [];
    } catch (error) {
      expect(error).toBeInstanceOf(AffectedError);
      return (error as Error).message;
    }
  };
  const C = ['src/c.spec.ts', 'src/c.ts'];

  it.each([
    ['path.resolve', "{ alias: { '@': path.resolve(__dirname, './src') } }"],
    ['path.join', "{ alias: { '@': path.join(__dirname, 'src') } }"],
    ['import.meta.dirname', "{ alias: { '@': path.resolve(import.meta.dirname, 'src') } }"],
    ['a URL', "{ alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } }"],
    ['a list', "{ alias: [{ find: '@', replacement: path.resolve(__dirname, 'src') }] }"],
  ])(
    'tells the gates apart with a Vite alias that settings.importAliases names (%s)',
    (_n, resolve) => {
      expect(told({ 'vitest.gates.config.ts': vitest(resolve) })).toEqual(C);
    }
  );

  it.each([
    ['one of the same path', "'^@/(.*)$': '<rootDir>/src/$1'", ALIASES],
    [
      'one into the directory above',
      "'^@common/(.*)$': '<rootDir>/../common/$1'",
      { settings: { importAliases: [{ prefix: '@common/', target: '../common/' }] } },
    ],
    ['a stub', "'\\\\.(css|less)$': '<rootDir>/test/style-stub.js'", ALIASES],
    ['a package', "'\\\\.(css|less)$': 'identity-obj-proxy'", ALIASES],
  ])('tells the gates apart with a moduleNameMapper of %s', (_n, entry, manifest) => {
    const found = told(
      {
        'jest.config.cjs': `module.exports = { rootDir: __dirname, moduleNameMapper: { ${entry} } };\n`,
        'test/style-stub.js': 'module.exports = {};\n',
      },
      manifest,
      'jest'
    );
    expect(found).toEqual(C);
  });

  it('tells the gates apart with tsconfig paths that settings.importAliases names', () => {
    expect(
      told({ 'tsconfig.json': '{ "compilerOptions": { "paths": { "@/*": ["./src/*"] } } }\n' })
    ).toEqual(C);
    expect(
      told({
        'tsconfig.json': '{ "compilerOptions": { "baseUrl": "src", "paths": { "@/*": ["*"] } } }\n',
      })
    ).toEqual(C);
  });

  it.each([
    [
      'an installed package mapped to a file of the project',
      vitest("{ alias: { 'left-pad': path.join(root, 'src', 'shims', 'left-pad.ts') } }").replace(
        'export default',
        'const root = import.meta.dirname;\nexport default'
      ),
      'vitest.gates.config.ts maps left-pad with alias in a way settings.importAliases does not name',
    ],
    [
      'an alias settings.importAliases does not name',
      vitest("{ alias: { '~': path.resolve(__dirname, 'src') } }"),
      'vitest.gates.config.ts maps ~ with alias in a way settings.importAliases does not name (add { "prefix": "~/", "target": "src/" } to settings.importAliases)',
    ],
    [
      'an alias to another directory',
      vitest("{ alias: { '@': path.resolve(__dirname, 'lib') } }"),
      'vitest.gates.config.ts maps @ with alias in a way settings.importAliases does not name',
    ],
    [
      'an alias found by a regular expression that is not a prefix',
      vitest(
        "{ alias: [{ find: /^(@|~)\\//, replacement: path.resolve(__dirname, 'src') + '/' }] }"
      ),
      'vitest.gates.config.ts maps /^(@|~)\\// with alias in a way settings.importAliases does not name',
    ],
    [
      'aliases of a variable',
      'const aliases = {};\nexport default { test: { alias: aliases } };\n',
      'vitest.gates.config.ts names alias in a way that cannot be read as a list of aliases',
    ],
  ])('refuses %s in a Vite config', (_n, config, message) => {
    expect(told({ 'vitest.gates.config.ts': config })).toBe(message);
  });

  it.each([
    [
      'more than one target',
      "{ '^@/(.*)$': ['<rootDir>/src/override/$1', '<rootDir>/src/$1'] }",
      'jest.config.cjs maps ^@/(.*)$ with moduleNameMapper in a way settings.importAliases does not name',
    ],
    [
      'a package mapped to files of the project',
      "{ '^left-pad/(.*)$': '<rootDir>/src/shims/$1' }",
      'jest.config.cjs maps ^left-pad/(.*)$ with moduleNameMapper in a way settings.importAliases does not name',
    ],
    [
      'a pattern that is not a prefix',
      "{ '^(.*)/legacy/(.*)$': '<rootDir>/src/$2' }",
      'jest.config.cjs maps ^(.*)/legacy/(.*)$ with moduleNameMapper in a way settings.importAliases does not name',
    ],
  ])('refuses a moduleNameMapper with %s', (_n, mapper, message) => {
    expect(
      told(
        { 'jest.config.cjs': `module.exports = { moduleNameMapper: ${mapper} };\n` },
        ALIASES,
        'jest'
      )
    ).toBe(message);
  });

  it('takes the stub a moduleNameMapper names for a config', () => {
    const dir = fixture(
      {
        'jest.config.cjs':
          "module.exports = { moduleNameMapper: { '\\\\.css$': '<rootDir>/test/style-stub.js' } };\n",
        'test/style-stub.js': 'module.exports = {};\n',
      },
      ALIASES
    );
    const { snapshot, root } = snapshotOf({ dir, written: ['reports'], args: [] });
    const found = affectedInputs(readManifest(dir), {
      root,
      files: snapshot.files,
      configs: runnerConfigs(dir, 'stryker.gates.config.mjs', { testRunner: 'jest' }),
      tests: [],
      covering: {},
    });
    expect(found.config).toContain('test/style-stub.js');
  });

  it('refuses a stub of moduleNameMapper by a rootDir that is not where the config lies', () => {
    expect(
      told(
        {
          'jest.config.cjs':
            "module.exports = { rootDir: 'src', moduleNameMapper: { '\\\\.css$': '<rootDir>/stub.js' } };\n",
          'src/stub.js': 'module.exports = {};\n',
        },
        ALIASES,
        'jest'
      )
    ).toBe("jest.config.cjs sets rootDir to a directory that cannot be told: 'src'");
  });

  it('refuses a moduleNameMapper of a rootDir that is not where the config lies', () => {
    expect(
      told(
        {
          'jest.config.cjs':
            "module.exports = { rootDir: 'src', moduleNameMapper: { '^@/(.*)$': '<rootDir>/$1' } };\n",
        },
        ALIASES,
        'jest'
      )
    ).toBe("jest.config.cjs sets rootDir to a directory that cannot be told: 'src'");
  });

  it('reads the moduleNameMapper of package.json when there is no Jest config', () => {
    expect(
      told(
        {
          'package.json': {
            name: 'fixture',
            private: true,
            jest: { moduleNameMapper: { '^@/(.*)$': ['<rootDir>/a/$1', '<rootDir>/src/$1'] } },
          },
        },
        ALIASES,
        'jest'
      )
    ).toBe(
      'package.json maps ^@/(.*)$ with moduleNameMapper in a way settings.importAliases does not name'
    );
  });

  it.each([
    [
      'more than one target',
      { compilerOptions: { paths: { '@/*': ['./src/override/*', './src/*'] } } },
      'tsconfig.json maps @/* with paths in a way settings.importAliases does not name',
    ],
    [
      'a package mapped to a file',
      { compilerOptions: { paths: { 'left-pad': ['./src/shims/left-pad.ts'] } } },
      'tsconfig.json maps left-pad with paths in a way settings.importAliases does not name',
    ],
  ])('refuses tsconfig paths with %s', (_n, tsconfig, message) => {
    expect(told({ 'tsconfig.json': tsconfig })).toBe(message);
  });

  it.each([
    [
      'a name bound with const',
      "const rootDir = path.dirname(fileURLToPath(import.meta.url));\nconst srcDir = path.resolve(rootDir, 'src');\n",
      '{ alias: { "@": srcDir } }',
    ],
    [
      'a regular expression with a path and a slash',
      '',
      "{ alias: [{ find: /^@\\//, replacement: path.resolve(__dirname, 'src') + '/' }] }",
    ],
  ])('tells the gates apart with a Vite alias of %s', (_n, head, resolve) => {
    expect(
      told({
        'vitest.gates.config.ts': vitest(resolve).replace(
          'export default',
          `${head}export default`
        ),
      })
    ).toEqual(C);
  });

  it('refuses a name that is bound more than once', () => {
    expect(
      told({
        'vitest.gates.config.ts': vitest('{ alias: { "@": srcDir } }').replace(
          'export default',
          "const srcDir = path.resolve(__dirname, 'src');\nfunction other() { let srcDir = 'x'; return srcDir; }\nexport default"
        ),
      })
    ).toBe(
      'vitest.gates.config.ts maps @ with alias in a way settings.importAliases does not name'
    );
  });

  it('refuses a Vite alias of an installed package to a directory, also where the settings name it', () => {
    expect(
      told(
        {
          'vitest.gates.config.ts': vitest("{ alias: { vitest: path.resolve(__dirname, 'src') } }"),
        },
        { settings: { importAliases: [{ prefix: 'vitest/', target: 'src/' }] } }
      )
    ).toBe(
      'vitest.gates.config.ts maps vitest with alias in a way settings.importAliases does not name'
    );
  });

  it.each([
    ['a target ""', "'^~/(.*)$': '<rootDir>/$1'", [{ prefix: '~/', target: '' }]],
    ['a target "./"', "'^~/(.*)$': '<rootDir>/$1'", [{ prefix: '~/', target: './' }]],
    [
      'a prefix within an alias',
      "'^~/core/(.*)$': '<rootDir>/core/$1', '^~/(.*)$': '<rootDir>/$1'",
      [{ prefix: '~/', target: '' }],
    ],
  ])(
    'tells the gates apart with a moduleNameMapper that an alias of %s names',
    (_n, entries, aliases) => {
      expect(
        told(
          { 'jest.config.cjs': `module.exports = { moduleNameMapper: { ${entries} } };\n` },
          { settings: { importAliases: aliases } },
          'jest'
        )
      ).toEqual(C);
    }
  );

  it('refuses a moduleNameMapper to a directory chosen when the config is loaded', () => {
    expect(
      told(
        {
          'jest.config.cjs':
            "const commonDir = require('node:fs').existsSync('a') ? 'a' : 'b';\n" +
            'module.exports = { moduleNameMapper: { "^@common/(.*)$": `${commonDir}/$1` } };\n',
        },
        ALIASES,
        'jest'
      )
    ).toBe(
      'jest.config.cjs maps ^@common/(.*)$ with moduleNameMapper in a way settings.importAliases does not name'
    );
  });

  it('names every map that is not named, and what to add to the settings', () => {
    expect(
      told({
        'vitest.gates.config.ts': vitest("{ alias: { '~': path.resolve(__dirname, 'test') } }"),
        'tsconfig.json': { compilerOptions: { paths: { '~/*': ['./test/*'], '#x': ['./x.ts'] } } },
      })
    ).toBe(
      'vitest.gates.config.ts maps ~ with alias in a way settings.importAliases does not name (add { "prefix": "~/", "target": "test/" } to settings.importAliases); ' +
        'tsconfig.json maps ~/* with paths in a way settings.importAliases does not name (add { "prefix": "~/", "target": "test/" } to settings.importAliases); ' +
        'tsconfig.json maps #x with paths in a way settings.importAliases does not name'
    );
  });

  it('takes tsconfig paths of one name to an installed package', () => {
    expect(
      told({
        'tsconfig.json': {
          compilerOptions: {
            paths: { '@acme/kit/google': ['./node_modules/@acme/kit/dist/google'] },
          },
        },
      })
    ).toEqual(C);
  });

  it('reads the paths of .swcrc also for a prefix the runner config maps, as SWC rewrites first', () => {
    expect(
      told(
        {
          'jest.config.cjs':
            "module.exports = { moduleNameMapper: { '^@/(.*)$': '<rootDir>/src/$1' } };\n",
          '.swcrc': { jsc: { baseUrl: '.', paths: { '@/*': ['src/*'], '@/test/*': ['test/*'] } } },
        },
        ALIASES,
        'jest'
      )
    ).toBe(
      '.swcrc maps @/test/* with paths in a way settings.importAliases does not name (add { "prefix": "@/test/", "target": "test/" } to settings.importAliases, before the alias of @/)'
    );
  });

  it('reads the paths of .swcrc as those of tsconfig.json', () => {
    const swcrc = { jsc: { baseUrl: '.', paths: { '@/*': ['src/*'], 'test/*': ['test/*'] } } };
    expect(
      told(
        { '.swcrc': swcrc },
        {
          settings: {
            importAliases: [
              { prefix: '@/', target: 'src/' },
              { prefix: 'test/', target: 'test/' },
            ],
          },
        }
      )
    ).toEqual(C);
    expect(told({ '.swcrc': swcrc })).toBe(
      '.swcrc maps test/* with paths in a way settings.importAliases does not name (add { "prefix": "test/", "target": "test/" } to settings.importAliases)'
    );
  });

  it('looks for module-resolver in the Babel config of package.json only', () => {
    const pkg = (extra: object) => ({ name: 'fixture', private: true, type: 'module', ...extra });
    expect(
      told({
        'package.json': pkg({ devDependencies: { 'babel-plugin-module-resolver': '5.0.0' } }),
      })
    ).toEqual(C);
    expect(
      told({
        'package.json': pkg({
          babel: { plugins: [['module-resolver', { alias: { '@': './src' } }]] },
        }),
      })
    ).toBe('package.json maps modules (module-resolver), which cannot be told');
  });

  it('leaves out tsconfig paths of a prefix the runner config maps, and all of them for Jest', () => {
    // The paths say ./, the alias of the runner, which comes first, says src/.
    const tsconfig = { compilerOptions: { paths: { '@/*': ['./*'], '#x': ['./x.ts'] } } };
    expect(
      told({
        'vitest.gates.config.ts': vitest("{ alias: { '@': path.resolve(__dirname, 'src') } }"),
        'tsconfig.json': { compilerOptions: { paths: { '@/*': ['./*'] } } },
      })
    ).toEqual(C);
    expect(
      told(
        { 'tsconfig.json': tsconfig, 'jest.config.cjs': 'module.exports = {};\n' },
        ALIASES,
        'jest'
      )
    ).toEqual(C);
    expect(told({ 'tsconfig.json': tsconfig })).toBe(
      'tsconfig.json maps @/* with paths in a way settings.importAliases does not name (add { "prefix": "@/", "target": "./" } to settings.importAliases, in place of the alias of @/); ' +
        'tsconfig.json maps #x with paths in a way settings.importAliases does not name'
    );
  });

  it('refuses a Babel config that maps modules', () => {
    expect(
      told({
        'babel.config.json': { plugins: [['module-resolver', { alias: { '@': './src' } }]] },
      })
    ).toBe('babel.config.json maps modules (module-resolver), which cannot be told');
  });
});

describe('an import of types only', () => {
  const TYPES = {
    'src/c.ts':
      "import type { Rate } from './rate';\nexport type { Fee } from './fee';\nimport { type Tax, type Due } from './tax';\nexport const c = (x: Rate): Tax => x - 1;\n",
    'src/rate.ts': 'export type Rate = number;\n',
    'src/fee.ts': 'export type Fee = number;\n',
    'src/tax.ts': 'export type Tax = number;\nexport type Due = number;\n',
    'tsconfig.json': '{ "compilerOptions": { "strict": true } }\n',
  };
  const ALL = ['src/c.spec.ts', 'src/c.ts', 'src/fee.ts', 'src/rate.ts', 'src/tax.ts'];

  /** The files of gate c, with a Stryker config and a runner config of the given text. */
  function filesOf(
    files: Record<string, string | null>,
    runner: 'vitest' | 'jest' = 'vitest',
    checkers?: string[],
    ignored: string[] = []
  ): string[] | undefined {
    const config = runner === 'vitest' ? 'vitest.gates.config.ts' : 'jest.gates.config.cjs';
    const dir = fixture({
      ...TYPES,
      'stryker.gates.config.mjs': `export default { testRunner: '${runner}' };\n`,
      'jest.gates.config.cjs': 'module.exports = {};\n',
      ...Object.fromEntries(Object.entries(files).filter(([, text]) => text !== null)),
    });
    for (const [file, text] of Object.entries(files)) {
      if (text === null) {
        fs.rmSync(path.join(dir, file));
      }
    }
    const { snapshot, root } = snapshotOf({ dir, written: [], args: [] });
    // as git would leave out a file it ignores
    ignored.forEach((file) => delete snapshot.files[file]);
    const configs = runnerConfigs(dir, 'stryker.gates.config.mjs', {
      testRunner: runner,
      vitestConfig: config,
      jestConfig: config,
      checkers,
    });
    return affectedInputs(readManifest(dir), {
      root,
      files: snapshot.files,
      configs,
      tests: [],
      covering: {},
    }).gates['src/c.ts']?.files;
  }

  it('leaves them out where the run does not check types (Vitest)', () => {
    expect(filesOf({})).toEqual(['src/c.spec.ts', 'src/c.ts']);
  });

  it('keeps a module that is also imported for a value', () => {
    expect(
      filesOf({
        'src/c.spec.ts': `${H}import { c } from './c';\nimport { rate } from './rate';\nit('c', () => { expect(c(rate)).toBe(0); });\n`,
        'src/rate.ts': 'export type Rate = number;\nexport const rate = 1;\n',
      })
    ).toEqual(['src/c.spec.ts', 'src/c.ts', 'src/rate.ts']);
  });

  it('keeps a module whose path the runner is given as text', () => {
    expect(
      filesOf({
        'src/c.spec.ts': `${H}import { c } from './c';\nimport type { Rate } from './rate';\nvi.mock('./rate');\nit('c', () => {});\n`,
      })
    ).toEqual(['src/c.spec.ts', 'src/c.ts', 'src/rate.ts']);
  });

  const SWC = {
    'jest.gates.config.cjs': "module.exports = { transform: { '^.+\\\\.ts$': '@swc/jest' } };\n",
  };

  it.each([
    ['createMockFromModule', "jest.createMockFromModule<Rate>('./rate');"],
    ['genMockFromModule', "jest.genMockFromModule('./rate');"],
  ])('keeps a module whose path is handed to %s', (_name, call) => {
    expect(
      filesOf(
        {
          ...SWC,
          'src/c.spec.ts': `import { c } from './c';\nimport type { Rate } from './rate';\nconst rate = ${call}\nit('c', () => { expect(c(rate)).toBe(0); });\n`,
        },
        'jest'
      )
    ).toEqual(['src/c.spec.ts', 'src/c.ts', 'src/rate.ts']);
  });

  it('follows the path of an import of types only where it is written elsewhere as text', () => {
    expect(
      filesOf(
        {
          ...SWC,
          'src/c.spec.ts': `import { c } from './c';\nimport type { Rate } from './rate';\nconst load = (name: string) => jest.requireActual(name);\nit('c', () => { expect(c(load('./rate'))).toBe(0); });\n`,
        },
        'jest'
      )
    ).toEqual(['src/c.spec.ts', 'src/c.ts', 'src/rate.ts']);
  });

  it('leaves out the path of an import of types only on its own line, also twice', () => {
    expect(
      filesOf(
        {
          ...SWC,
          'src/c.spec.ts': `import { c } from './c';\nimport type { Rate } from './rate'; import type { Due } from './rate';\nit('c', () => { expect(c(1 as Rate)).toBe(0); });\n`,
        },
        'jest'
      )
    ).toEqual(['src/c.spec.ts', 'src/c.ts']);
  });

  it.each([
    ['verbatimModuleSyntax', '{ "compilerOptions": { "verbatimModuleSyntax": true } }\n'],
    ['preserveValueImports', '{ "compilerOptions": { "preserveValueImports": true } }\n'],
    ['a base it extends', '{ "extends": "./tsconfig.base.json" }\n'],
    ['a base it extends that is not there', '{ "extends": "@acme/tsconfig/base.json" }\n'],
  ])(
    'keeps an import of type names, which may still load the module, with %s',
    (_name, tsconfig) => {
      expect(
        filesOf({
          'tsconfig.json': tsconfig,
          'tsconfig.base.json': '{ "compilerOptions": { "verbatimModuleSyntax": true } }\n',
        })
      ).toEqual(['src/c.spec.ts', 'src/c.ts', 'src/tax.ts']);
    }
  );

  it('leaves out an import of type names with a base it extends that does not keep them', () => {
    expect(
      filesOf({
        'tsconfig.json': '{ "extends": "./tsconfig.base.json" }\n',
        'tsconfig.base.json': '{ "compilerOptions": { "strict": true } }\n',
      })
    ).toEqual(['src/c.spec.ts', 'src/c.ts']);
  });

  it('keeps an import of type names with a base it extends that is not compared', () => {
    expect(
      filesOf(
        {
          'tsconfig.json': '{ "extends": "./.generated/tsconfig.json" }\n',
          '.generated/tsconfig.json': '{ "compilerOptions": { "strict": true } }\n',
        },
        'vitest',
        undefined,
        ['.generated/tsconfig.json']
      )
    ).toEqual(['src/c.spec.ts', 'src/c.ts', 'src/tax.ts']);
  });

  it('keeps an import of type names with a Babel config above the subproject that keeps them', () => {
    const root = project({
      'package.json': { name: 'root', private: true, workspaces: ['pkg'] },
      'babel.config.json':
        '{ "presets": [["@babel/preset-typescript", { "onlyRemoveTypeImports": true }]] }\n',
      'node_modules/vitest/package.json': '{ "name": "vitest" }',
    });
    const dir = path.join(root, 'pkg');
    write(dir, {
      'test-gates.json': { gates: [gate('src/c.ts')], candidates: [] },
      'stryker.gates.config.mjs': "export default { testRunner: 'vitest' };\n",
      'vitest.config.ts': 'export default {};\n',
      'tsconfig.json': '{}\n',
      'src/c.ts': "import { type Tax } from './tax';\nexport const c = (x: number): Tax => x;\n",
      'src/tax.ts': 'export type Tax = number;\n',
      'src/c.spec.ts': `${H}import { c } from './c';\nit('c', () => { expect(c(1)).toBe(1); });\n`,
    });
    const { snapshot, root: listed } = snapshotOf({ dir, written: [], args: [] });
    const found = affectedInputs(readManifest(dir), {
      root: listed,
      files: snapshot.files,
      configs: runnerConfigs(dir, 'stryker.gates.config.mjs', { testRunner: 'vitest' }),
      tests: [],
      covering: {},
    });
    expect(found.gates['src/c.ts']?.files).toEqual([
      'pkg/src/c.spec.ts',
      'pkg/src/c.ts',
      'pkg/src/tax.ts',
    ]);
  });

  it('keeps an import of type names without a tsconfig.json to tell', () => {
    expect(filesOf({ 'tsconfig.json': null })).toEqual(['src/c.spec.ts', 'src/c.ts', 'src/tax.ts']);
  });

  it.each([
    [
      'Vitest with typecheck',
      'vitest',
      { 'vitest.gates.config.ts': 'export default { test: { typecheck: { enabled: true } } };\n' },
    ],
    [
      'the TypeScript checker of Stryker, in its config',
      'vitest',
      {
        'stryker.gates.config.mjs':
          "export default { testRunner: 'vitest', checkers: ['typescript'] };\n",
      },
    ],
    ['ts-jest', 'jest', { 'jest.gates.config.cjs': "module.exports = { preset: 'ts-jest' };\n" }],
    [
      'ts-jest as a transform',
      'jest',
      {
        'jest.gates.config.cjs': "module.exports = { transform: { '^.+\\\\.ts$': 'ts-jest' } };\n",
      },
    ],
    [
      'Jest with a preset',
      'jest',
      {
        'jest.gates.config.cjs':
          "module.exports = { preset: '@acme/jest-preset', transform: { '^.+\\\\.ts$': '@swc/jest' } };\n",
      },
    ],
    ['Jest with no transform it names', 'jest', {}],
    [
      'ts-jest, with a comment that names an option',
      'jest',
      {
        'jest.gates.config.cjs':
          "// isolatedModules: true would be faster\nmodule.exports = { preset: 'ts-jest' };\n",
      },
    ],
    [
      'ts-jest with compiler options in place',
      'jest',
      {
        'jest.gates.config.cjs':
          "module.exports = { transform: { '^.+\\\\.ts$': ['ts-jest', { tsconfig: { isolatedModules: true } }] } };\n",
      },
    ],
    [
      'ts-jest with projects',
      'jest',
      {
        'jest.gates.config.cjs':
          "module.exports = { projects: [{ preset: 'ts-jest' }, { transform: { '^.+\\\\.ts$': ['ts-jest', { diagnostics: false }] } }] };\n",
      },
    ],
  ] as const)('keeps them where the run may check types: %s', (_name, runner, files) => {
    expect(filesOf(files, runner)).toEqual(ALL);
  });

  it('keeps them where the Stryker config names a checker', () => {
    expect(filesOf({}, 'vitest', ['typescript'])).toEqual(ALL);
  });

  it.each([
    [
      'ts-jest with isolatedModules',
      "module.exports = { transform: { '^.+\\\\.ts$': ['ts-jest', { isolatedModules: true }] } };\n",
    ],
    [
      'ts-jest without diagnostics',
      "module.exports = { transform: { '^.+\\\\.ts$': ['ts-jest', { diagnostics: false }] } };\n",
    ],
    ['@swc/jest', "module.exports = { transform: { '^.+\\\\.ts$': '@swc/jest' } };\n"],
    ['babel-jest', "module.exports = { transform: { '^.+\\\\.ts$': 'babel-jest' } };\n"],
  ])('leaves them out where Jest only strips types: %s', (_name, config) => {
    expect(filesOf({ 'jest.gates.config.cjs': config }, 'jest')).toEqual([
      'src/c.spec.ts',
      'src/c.ts',
    ]);
  });
});

describe('runnerConfigs', () => {
  it.each([
    [[], false],
    [['--checkers', 'typescript'], true],
    [['--checkers=typescript'], true],
    [['--concurrency', '2'], false],
  ])('sees checkers given to Stryker as arguments: %j', (args, checkers) => {
    const dir = fixture();
    const decision = decideReuse(readManifest(dir), 'stryker.gates.config.mjs', args, false, true);
    expect(decision.configs().checkers).toBe(checkers);
  });

  it('finds the config the Stryker config names, or the default of the runner', () => {
    const dir = project({
      'stryker.gates.config.mjs': 'export default {};\n',
      'jest.gates.config.cjs': 'module.exports = {};\n',
      'jest.config.js': 'module.exports = {};\n',
      'vite.config.ts': 'export default {};\n',
    });
    const real = fs.realpathSync(dir);
    expect(
      runnerConfigs(dir, 'stryker.gates.config.mjs', {
        testRunner: 'jest',
        jestConfig: 'jest.gates.config.cjs',
      }).files
    ).toEqual([
      path.join(real, 'stryker.gates.config.mjs'),
      path.join(real, 'jest.gates.config.cjs'),
    ]);
    expect(runnerConfigs(dir, 'stryker.gates.config.mjs', { testRunner: 'jest' }).files).toEqual([
      path.join(real, 'stryker.gates.config.mjs'),
      path.join(real, 'jest.config.js'),
    ]);
    expect(runnerConfigs(dir, 'stryker.gates.config.mjs', { testRunner: 'vitest' }).files).toEqual([
      path.join(real, 'stryker.gates.config.mjs'),
      path.join(real, 'vite.config.ts'),
    ]);
  });

  it('refuses another test runner', () => {
    expect(() => runnerConfigs('.', 'x.mjs', { testRunner: 'mocha' })).toThrow(
      new AffectedError(
        '--affected knows the test runners jest and vitest, the Stryker config uses mocha'
      )
    );
  });
});
