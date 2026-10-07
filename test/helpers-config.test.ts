import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { createJestGatesConfig } from '../src/jest';
import { gateSpecs, loadGates, readManifest } from '../src/load';
import { existsExact, findLocalBin } from '../src/fs';
import { createStrykerGatesConfig } from '../src/stryker';
import { createVitestGatesConfig } from '../src/vitest';
import { cleanup, gateEntry, project, repoRoot, validProject, write } from './helpers';

afterAll(cleanup);

const FULL = { statements: 100, branches: 100, functions: 100, lines: 100 };

const twoGates = (settings?: object) =>
  validProject(
    { 'src/rate.ts': 'export const rate = 1;\n', 'src/rate.test.ts': "it('x', () => {});\n" },
    {
      gates: [gateEntry, { path: 'src/rate.ts', decides: 'd', impact: 'i' }],
      ...(settings ? { settings } : {}),
    }
  );

describe('loadGates', () => {
  it('resolves the spec of each gate, whichever of the two conventions it follows', () => {
    const dir = twoGates();
    const manifest = loadGates(dir);
    expect(manifest.dir).toBe(dir);
    expect(manifest.gates.map((gate) => [gate.path, gate.spec])).toEqual([
      ['src/age.ts', 'src/age.spec.ts'],
      ['src/rate.ts', 'src/rate.test.ts'],
    ]);
    expect(manifest.gates[0]?.specCandidates).toEqual(['src/age.spec.ts', 'src/age.test.ts']);
    expect(manifest.candidates).toEqual([]);
    expect(manifest.settings.strykerReportFile).toBe('reports/mutation/mutation.json');
  });

  it('falls back to the first candidate when no spec exists, so the gate still fails on coverage', () => {
    const dir = validProject();
    fs.rmSync(path.join(dir, 'src/age.spec.ts'));
    const [gate] = loadGates(dir).gates;
    expect(gate?.spec).toBe('src/age.spec.ts');
    expect(gate?.existingSpecs).toEqual([]);
  });

  it('has no spec when the project has no spec convention', () => {
    const dir = validProject({}, { settings: { spec: { suffixes: [] } } });
    expect(loadGates(dir).gates[0]?.spec).toBeNull();
  });

  it('throws when the manifest has problems, listing them', () => {
    const dir = validProject({}, { gates: [{ path: 'src/age.ts' }] });
    expect(() => loadGates(dir)).toThrow(
      'test-gates.json has problems (run "test-gates check"):\n' +
        '  - src/age.ts: "decides" is missing in gates\n' +
        '  - src/age.ts: "impact" is missing in gates'
    );
    expect(readManifest(dir).violations).toHaveLength(2);
  });

  it('throws when test-gates.json is missing or a setting is unknown', () => {
    const empty = project({ 'x.txt': '' });
    expect(() => loadGates(empty)).toThrow(`test-gates.json not found in ${empty}`);
    const typo = validProject({}, { settings: { spec: { suffix: ['.spec.ts'] } } });
    expect(() => loadGates(typo)).toThrow('test-gates.json: settings.spec: unknown key "suffix"');
  });

  it('uses the current directory by default', () => {
    const dir = validProject();
    const previous = process.cwd();
    process.chdir(dir);
    try {
      expect(loadGates().dir).toBe(dir);
    } finally {
      process.chdir(previous);
    }
  });
});

describe('gateSpecs', () => {
  it('returns the spec of every gate', () => {
    expect(gateSpecs(loadGates(twoGates()), {})).toEqual(['src/age.spec.ts', 'src/rate.test.ts']);
  });

  it('leaves out exactly the spec named by TEST_GATES_EXCLUDE_SPEC', () => {
    const manifest = loadGates(twoGates());
    expect(gateSpecs(manifest, { TEST_GATES_EXCLUDE_SPEC: 'src/age.spec.ts' })).toEqual([
      'src/rate.test.ts',
    ]);
    expect(gateSpecs(manifest, { TEST_GATES_EXCLUDE_SPEC: 'src/age.ts' })).toHaveLength(2);
    expect(gateSpecs(manifest, { TEST_GATES_EXCLUDE_SPEC: '' })).toHaveLength(2);
  });

  it('reads process.env by default', () => {
    const manifest = loadGates(twoGates());
    process.env.TEST_GATES_EXCLUDE_SPEC = 'src/rate.test.ts';
    try {
      expect(gateSpecs(manifest)).toEqual(['src/age.spec.ts']);
    } finally {
      delete process.env.TEST_GATES_EXCLUDE_SPEC;
    }
  });
});

describe('createJestGatesConfig', () => {
  it('runs only the specs of the gates and holds every gate to 100% on four metrics', () => {
    const dir = twoGates();
    expect(createJestGatesConfig({ rootDir: dir })).toEqual({
      rootDir: dir,
      testEnvironment: 'node',
      testMatch: ['<rootDir>/src/age.spec.ts', '<rootDir>/src/rate.test.ts'],
      passWithNoTests: true,
      collectCoverage: true,
      coverageProvider: 'babel',
      collectCoverageFrom: ['<rootDir>/src/age.ts', '<rootDir>/src/rate.ts'],
      coverageDirectory: '<rootDir>/coverage/gates',
      coverageReporters: ['text'],
      coverageThreshold: {
        [path.join(dir, 'src/age.ts')]: FULL,
        [path.join(dir, 'src/rate.ts')]: FULL,
      },
    });
  });

  it('passes other options through', () => {
    const config = createJestGatesConfig({
      rootDir: validProject(),
      transform: { '^.+\\.ts$': ['@swc/jest'] },
      moduleNameMapper: { '^@/(.*)$': '<rootDir>/src/$1' },
      testEnvironment: 'jsdom',
      coverageReporters: ['text', 'json-summary'],
    });
    expect(config).toMatchObject({
      transform: { '^.+\\.ts$': ['@swc/jest'] },
      moduleNameMapper: { '^@/(.*)$': '<rootDir>/src/$1' },
      testEnvironment: 'jsdom',
      coverageReporters: ['text', 'json-summary'],
    });
  });

  it('does not let options replace the keys that make it a gate', () => {
    const dir = validProject();
    const config = createJestGatesConfig({
      rootDir: dir,
      testMatch: ['**/*.spec.ts'],
      collectCoverage: false,
      coverageProvider: 'v8',
      collectCoverageFrom: ['src/**'],
      coverageThreshold: { global: { lines: 10 } },
    });
    expect(config).toMatchObject({
      rootDir: dir,
      testMatch: ['<rootDir>/src/age.spec.ts'],
      collectCoverage: true,
      coverageProvider: 'babel',
      collectCoverageFrom: ['<rootDir>/src/age.ts'],
      coverageThreshold: { [path.join(dir, 'src/age.ts')]: FULL },
    });
  });

  it('leaves the excluded spec out of testMatch but keeps the gate measured', () => {
    const dir = twoGates();
    process.env.TEST_GATES_EXCLUDE_SPEC = 'src/age.spec.ts';
    try {
      const config = createJestGatesConfig({ rootDir: dir });
      expect(config.testMatch).toEqual(['<rootDir>/src/rate.test.ts']);
      expect(config.collectCoverageFrom).toEqual(['<rootDir>/src/age.ts', '<rootDir>/src/rate.ts']);
      expect(Object.keys(config.coverageThreshold as object)).toHaveLength(2);
    } finally {
      delete process.env.TEST_GATES_EXCLUDE_SPEC;
    }
  });

  it('never leaves testMatch empty: Jest would run every test of the project', () => {
    const dir = validProject();
    process.env.TEST_GATES_EXCLUDE_SPEC = 'src/age.spec.ts';
    try {
      const config = createJestGatesConfig({ rootDir: dir, passWithNoTests: false });
      expect(config.testMatch).toEqual(['<rootDir>/__test_gates_no_spec_left__']);
      expect(config.passWithNoTests).toBe(true);
      expect(config.collectCoverageFrom).toEqual(['<rootDir>/src/age.ts']);
    } finally {
      delete process.env.TEST_GATES_EXCLUDE_SPEC;
    }
  });

  it('accepts import.meta.url of the config file as rootDir', () => {
    const dir = validProject();
    const url = pathToFileURL(path.join(dir, 'jest.gates.config.mjs')).href;
    expect(createJestGatesConfig({ rootDir: url }).rootDir).toBe(dir);
  });

  it('throws on a broken manifest instead of gating the wrong files', () => {
    expect(() => createJestGatesConfig({ rootDir: project({ 'test-gates.json': '{' }) })).toThrow(
      /not valid JSON/
    );
  });
});

describe('createVitestGatesConfig', () => {
  it('runs only the specs of the gates with per-file 100% thresholds and no path keys', () => {
    const dir = twoGates();
    expect(createVitestGatesConfig({ rootDir: dir })).toEqual({
      root: dir,
      test: {
        environment: 'node',
        include: ['src/age.spec.ts', 'src/rate.test.ts'],
        passWithNoTests: true,
        coverage: {
          provider: 'v8',
          enabled: true,
          reporter: ['text'],
          reportsDirectory: 'coverage/gates',
          include: ['src/age.ts', 'src/rate.ts'],
          thresholds: { perFile: true, ...FULL },
        },
      },
    });
  });

  it('passes other options through and merges test and coverage options', () => {
    const config = createVitestGatesConfig({
      rootDir: validProject(),
      resolve: { alias: { '~': '/app' } },
      test: {
        globals: true,
        environment: 'jsdom',
        exclude: ['node_modules'],
        coverage: { provider: 'istanbul', exclude: ['src/generated/**'] },
      },
    });
    expect(config).toMatchObject({
      resolve: { alias: { '~': '/app' } },
      test: {
        globals: true,
        environment: 'jsdom',
        exclude: ['node_modules'],
        coverage: { provider: 'istanbul', exclude: ['src/generated/**'], enabled: true },
      },
    });
  });

  it('does not let options replace the keys that make it a gate', () => {
    const dir = validProject();
    const config = createVitestGatesConfig({
      rootDir: dir,
      root: '/elsewhere',
      test: {
        include: ['**/*.spec.ts'],
        passWithNoTests: false,
        coverage: {
          enabled: false,
          include: ['src/**'],
          thresholds: { lines: 10, 'src/**': { lines: 0 } },
        },
      },
    }) as { root: string; test: { include: string[]; passWithNoTests: boolean; coverage: object } };
    expect(config.root).toBe(dir);
    expect(config.test.include).toEqual(['src/age.spec.ts']);
    expect(config.test.passWithNoTests).toBe(true);
    expect(config.test.coverage).toMatchObject({
      enabled: true,
      include: ['src/age.ts'],
      thresholds: { perFile: true, ...FULL },
    });
    expect(Object.keys((config.test.coverage as { thresholds: object }).thresholds)).toHaveLength(
      5
    );
  });

  it('leaves the excluded spec out but keeps the gate measured', () => {
    const dir = twoGates();
    process.env.TEST_GATES_EXCLUDE_SPEC = 'src/rate.test.ts';
    try {
      const config = createVitestGatesConfig({ rootDir: dir }) as {
        test: { include: string[]; coverage: { include: string[] } };
      };
      expect(config.test.include).toEqual(['src/age.spec.ts']);
      expect(config.test.coverage.include).toEqual(['src/age.ts', 'src/rate.ts']);
    } finally {
      delete process.env.TEST_GATES_EXCLUDE_SPEC;
    }
  });
});

describe('createVitestGatesConfig with no spec left', () => {
  it('uses a pattern that matches nothing instead of an empty include', () => {
    const dir = validProject();
    process.env.TEST_GATES_EXCLUDE_SPEC = 'src/age.spec.ts';
    try {
      const config = createVitestGatesConfig({ rootDir: dir }) as {
        test: { include: string[]; coverage: { include: string[] } };
      };
      expect(config.test.include).toEqual(['__test_gates_no_spec_left__']);
      expect(config.test.coverage.include).toEqual(['src/age.ts']);
    } finally {
      delete process.env.TEST_GATES_EXCLUDE_SPEC;
    }
  });
});

describe('createStrykerGatesConfig', () => {
  it('mutates exactly the gates, never breaks on the score and writes the JSON report', () => {
    expect(createStrykerGatesConfig({ rootDir: twoGates(), testRunner: 'jest' })).toEqual({
      testRunner: 'jest',
      mutate: ['src/age.ts', 'src/rate.ts'],
      coverageAnalysis: 'perTest',
      thresholds: { high: 100, low: 100, break: null },
      incremental: true,
      incrementalFile: 'reports/stryker-incremental.json',
      reporters: ['clear-text', 'progress', 'json'],
      jsonReporter: { fileName: 'reports/mutation/mutation.json' },
      clearTextReporter: { logTests: false, reportTests: false },
      tempDirName: '.stryker-tmp',
    });
  });

  it('writes the report where settings.stryker.reportFile says', () => {
    const dir = validProject(
      {},
      { settings: { stryker: { reportFile: 'reports/mutation/gates.json' } } }
    );
    expect(createStrykerGatesConfig({ rootDir: dir }).jsonReporter).toEqual({
      fileName: 'reports/mutation/gates.json',
    });
  });

  it('keeps the options it owns, whatever is passed', () => {
    const config = createStrykerGatesConfig({
      rootDir: validProject(),
      mutate: ['src/**/*.ts'],
      thresholds: { high: 80, low: 60, break: 50 },
      reporters: ['html'],
      jsonReporter: { fileName: 'elsewhere.json' },
      incremental: false,
      concurrency: 1,
      jest: { configFile: 'jest.gates.config.js' },
    });
    expect(config).toMatchObject({
      mutate: ['src/age.ts'],
      thresholds: { high: 80, low: 60, break: null },
      reporters: ['html', 'json'],
      jsonReporter: { fileName: 'reports/mutation/mutation.json' },
      incremental: false,
      concurrency: 1,
      jest: { configFile: 'jest.gates.config.js' },
    });
  });

  it('does not add json twice', () => {
    const config = createStrykerGatesConfig({
      rootDir: validProject(),
      reporters: ['json', 'html'],
    });
    expect(config.reporters).toEqual(['json', 'html']);
  });

  it.each([
    ['ignoreStatic', { ignoreStatic: true }],
    ['ignorers', { ignorers: ['x'] }],
    ['mutator.excludedMutations', { mutator: { excludedMutations: ['StringLiteral'] } }],
  ])('rejects %s', (name, option) => {
    expect(() => createStrykerGatesConfig({ rootDir: validProject(), ...option })).toThrow(
      `test-gates: "${name}" takes mutants out of the evaluation`
    );
  });

  it('accepts a mutator option that excludes nothing', () => {
    const config = createStrykerGatesConfig({
      rootDir: validProject(),
      mutator: { plugins: ['decorators'], excludedMutations: [] },
    });
    expect(config.mutator).toEqual({ plugins: ['decorators'], excludedMutations: [] });
  });
});

describe('existsExact / findLocalBin', () => {
  it('finds files only, unless asked for anything', () => {
    const dir = project({ 'a/b.ts': '', 'a/c/d.ts': '' });
    expect(existsExact(dir, 'a/b.ts')).toBe(true);
    expect(existsExact(dir, './a/b.ts')).toBe(true);
    expect(existsExact(dir, 'a/c')).toBe(false);
    expect(existsExact(dir, 'a/c', 'any')).toBe(true);
    expect(existsExact(dir, 'a/missing.ts')).toBe(false);
    expect(existsExact(dir, 'a/missing', 'any')).toBe(false);
    expect(existsExact(dir, 'a/b.ts/c')).toBe(false);
    expect(existsExact(path.join(dir, 'nope'), 'a')).toBe(false);
  });

  it('compares every segment with its exact spelling', () => {
    const dir = project({ 'src/Plan.ts': '' });
    expect(existsExact(dir, 'src/Plan.ts')).toBe(true);
    expect(existsExact(dir, 'src/plan.ts')).toBe(false);
    expect(existsExact(dir, 'Src/Plan.ts')).toBe(false);
  });

  it('finds a bin in the project or in an ancestor, the nearest first', () => {
    const dir = project({
      'node_modules/.bin/jest': '',
      'node_modules/.bin/stryker': '',
      'packages/api/node_modules/.bin/jest': '',
      'packages/api/src/x.ts': '',
    });
    const api = path.join(dir, 'packages/api');
    expect(findLocalBin(api, 'jest')).toBe(path.join(api, 'node_modules/.bin/jest'));
    expect(findLocalBin(api, 'stryker')).toBe(path.join(dir, 'node_modules/.bin/stryker'));
    expect(findLocalBin(api, 'test-gates-no-such-bin')).toBeNull();
  });
});

describe('the built package', () => {
  const run = (args: string[], cwd: string) =>
    spawnSync(process.execPath, args, { cwd, encoding: 'utf8' });

  it('can be required from a CommonJS config and imported from an ES module', () => {
    const dir = validProject();
    write(dir, {
      'cjs.cjs': `
        const { createJestGatesConfig } = require(${JSON.stringify(path.join(repoRoot, 'dist/jest.cjs'))});
        const { createVitestGatesConfig } = require(${JSON.stringify(path.join(repoRoot, 'dist/vitest.cjs'))});
        const { createStrykerGatesConfig } = require(${JSON.stringify(path.join(repoRoot, 'dist/stryker.cjs'))});
        const { loadGates } = require(${JSON.stringify(path.join(repoRoot, 'dist/index.cjs'))});
        console.log(JSON.stringify([
          createJestGatesConfig({ rootDir: __dirname }).testMatch,
          createVitestGatesConfig({ rootDir: __dirname }).test.include,
          createStrykerGatesConfig({ rootDir: __dirname }).mutate,
          loadGates(__dirname).gates.length,
        ]));`,
      'esm.mjs': `
        import { createJestGatesConfig } from ${JSON.stringify(pathToFileURL(path.join(repoRoot, 'dist/jest.js')).href)};
        import { createVitestGatesConfig } from ${JSON.stringify(pathToFileURL(path.join(repoRoot, 'dist/vitest.js')).href)};
        import { createStrykerGatesConfig } from ${JSON.stringify(pathToFileURL(path.join(repoRoot, 'dist/stryker.js')).href)};
        import { loadGates } from ${JSON.stringify(pathToFileURL(path.join(repoRoot, 'dist/index.js')).href)};
        console.log(JSON.stringify([
          createJestGatesConfig({ rootDir: import.meta.url }).testMatch,
          createVitestGatesConfig({ rootDir: import.meta.url }).test.include,
          createStrykerGatesConfig({ rootDir: import.meta.url }).mutate,
          loadGates(process.cwd()).gates.length,
        ]));`,
    });
    const expected = [['<rootDir>/src/age.spec.ts'], ['src/age.spec.ts'], ['src/age.ts'], 1];
    for (const file of ['cjs.cjs', 'esm.mjs']) {
      const result = run([file], dir);
      expect(result.stderr).toBe('');
      expect(JSON.parse(result.stdout)).toEqual(expected);
    }
  });

  it('ships a JSON schema that names every setting the resolver accepts', () => {
    const schema = JSON.parse(
      fs.readFileSync(path.join(repoRoot, 'schema/test-gates.schema.json'), 'utf8')
    );
    expect(Object.keys(schema.definitions.settings.properties).sort()).toEqual([
      'forbiddenSource',
      'gateCommand',
      'gateExtensions',
      'importAliases',
      'impureImports',
      'impureNamedImports',
      'impurePaths',
      'lcov',
      'selfcheck',
      'spec',
      'stryker',
    ]);
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    expect(pkg.exports['./schema.json']).toBe('./schema/test-gates.schema.json');
    expect(pkg.files).toContain('schema');
  });
});
