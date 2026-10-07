import { describe, expect, it } from 'vitest';
import { resolveSettings, SettingsError } from './settings';

describe('resolveSettings: defaults', () => {
  const defaults = resolveSettings(undefined);

  it('gates TypeScript and JavaScript modules', () => {
    expect(defaults.gateExtensions).toEqual(['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs']);
  });

  it('derives the spec name from the gate and does not move it', () => {
    expect(defaults.specSuffixes).toBeNull();
    expect(defaults.specRewrite).toEqual([]);
  });

  it('reads the Stryker report from reports/mutation/mutation.json', () => {
    expect(defaults.strykerReportFile).toBe('reports/mutation/mutation.json');
    expect(defaults.strykerConfigFile).toBeNull();
  });

  it('runs the negative control for every gate, with the built-in failure detection', () => {
    expect(defaults.selfcheckMode).toBe('all');
    expect(defaults.selfcheckFailurePattern).toBeNull();
    expect(defaults.gateCommand).toBeNull();
  });

  it('bans PrismaClient by name and nothing else from @prisma/client', () => {
    expect(defaults.impureNamedImports).toEqual([
      { module: '@prisma/client', names: ['PrismaClient'], reason: 'connects to the database' },
    ]);
    expect(defaults.impureImports.some((rule) => rule.regex.test('@prisma/client'))).toBe(false);
  });

  it.each([
    '@nestjs/common',
    'typeorm',
    'react',
    'react-dom',
    'react-dom/client',
    'vue',
    'next',
    'next/navigation',
    'nuxt',
    '#app',
    '#imports',
    'express',
    'pg',
  ])('treats %s as an impure import', (module) => {
    expect(defaults.impureImports.some((rule) => rule.regex.test(module))).toBe(true);
  });

  it.each([
    'decimal.js',
    'date-fns',
    'zod',
    './money',
    'node:path',
    'node:crypto',
    'nextjs-toploader-x',
    'vuelidate',
  ])('does not treat %s as an impure import', (module) => {
    expect(defaults.impureImports.some((rule) => rule.regex.test(module))).toBe(false);
  });

  it('rejects components and declaration files as gates', () => {
    const matches = (file: string) => defaults.impurePaths.some((rule) => rule.regex.test(file));
    expect(['a.vue', 'a.tsx', 'a.jsx', 'a.d.ts', 'a.d.mts'].map(matches)).toEqual([
      true,
      true,
      true,
      true,
      true,
    ]);
    expect(['a.ts', 'src/d.ts', 'a.js'].map(matches)).toEqual([false, false, false]);
  });

  it('has no aliases, no lcov file and no summary excludes', () => {
    expect(defaults.importAliases).toEqual([]);
    expect(defaults.allowedImports).toEqual([]);
    expect(defaults.lcovFile).toBeNull();
    expect(defaults.lcovSummaryExclude).toEqual([]);
  });

  it('uses the blocklist, with no package allow list and no timeout limit', () => {
    expect(defaults.importMode).toBe('blocklist');
    expect(defaults.importAllow).toEqual([]);
    expect(defaults.maxTimeouts).toBeNull();
  });

  it('gives the same result for an empty object', () => {
    expect(resolveSettings({})).toEqual(defaults);
  });
});

describe('resolveSettings: overrides', () => {
  it('takes every setting', () => {
    const settings = resolveSettings({
      gateExtensions: ['.dart'],
      spec: { suffixes: ['_test.dart'], rewrite: [{ from: '^lib/', to: 'test/' }] },
      impureImports: { defaults: false, add: ['^dart:io$'], allow: ['^dart:io/safe$'] },
      impureNamedImports: { defaults: false, add: [{ module: 'm', names: ['n'] }] },
      impurePaths: { defaults: false, add: [{ pattern: '^LIB/', flags: 'i', reason: 'no' }] },
      forbiddenSource: { defaults: false, add: ['TODO'] },
      importAliases: [{ prefix: '@/', target: 'src/' }],
      gateCommand: ['npx', 'jest', '--config', 'jest.gates.config.js'],
      selfcheck: { mode: 'first', failurePattern: 'threshold.*{gate}' },
      stryker: { configFile: 'stryker.conf.mjs', reportFile: 'out/m.json' },
      lcov: { file: 'coverage/lcov.info', summaryExclude: ['\\.g\\.dart$'] },
      imports: {
        mode: 'allowlist',
        allow: [
          'decimal.js',
          { pattern: '^@ACME/pure-', flags: 'i' },
          { module: '@prisma/client', names: ['Prisma'] },
        ],
      },
      mutation: { maxTimeouts: 0 },
    });
    expect(settings).toEqual({
      gateExtensions: ['.dart'],
      specSuffixes: ['_test.dart'],
      specRewrite: [{ regex: /^lib\//, to: 'test/' }],
      impureImports: [{ regex: /^dart:io$/, reason: 'matches ^dart:io$' }],
      allowedImports: [/^dart:io\/safe$/],
      impureNamedImports: [{ module: 'm', names: ['n'], reason: 'not allowed in a pure module' }],
      impurePaths: [{ regex: /^LIB\//i, reason: 'no' }],
      forbiddenSource: [{ regex: /TODO/, reason: 'matches TODO' }],
      importAliases: [{ prefix: '@/', target: 'src/' }],
      gateCommand: ['npx', 'jest', '--config', 'jest.gates.config.js'],
      selfcheckMode: 'first',
      selfcheckFailurePattern: 'threshold.*{gate}',
      strykerConfigFile: 'stryker.conf.mjs',
      strykerReportFile: 'out/m.json',
      lcovFile: 'coverage/lcov.info',
      lcovSummaryExclude: [/\.g\.dart$/],
      importMode: 'allowlist',
      importAllow: [
        { module: 'decimal.js' },
        { regex: /^@ACME\/pure-/i },
        { module: '@prisma/client', names: ['Prisma'] },
      ],
      maxTimeouts: 0,
    });
  });

  it('adds to the defaults unless defaults is false', () => {
    const base = resolveSettings(undefined);
    const added = resolveSettings({
      impureImports: { add: ['^lodash$'] },
      impureNamedImports: { add: [{ module: 'm', names: ['n'], reason: 'r' }] },
      impurePaths: { add: ['^gen/'] },
      forbiddenSource: { defaults: true, add: ['x'] },
    });
    expect(added.impureImports).toHaveLength(base.impureImports.length + 1);
    expect(added.impureNamedImports).toHaveLength(base.impureNamedImports.length + 1);
    expect(added.impureNamedImports.at(-1)).toEqual({ module: 'm', names: ['n'], reason: 'r' });
    expect(added.impurePaths).toHaveLength(base.impurePaths.length + 1);
    expect(added.forbiddenSource).toHaveLength(base.forbiddenSource.length + 1);
  });

  it('accepts an empty suffix list (a project without a spec convention)', () => {
    expect(resolveSettings({ spec: { suffixes: [] } }).specSuffixes).toEqual([]);
  });
});

describe('resolveSettings: mistakes are errors, not silent defaults', () => {
  it.each([
    ['settings as an array', [], 'settings: must be an object'],
    ['settings as a string', 'x', 'settings: must be an object'],
    ['settings as null', null, 'settings: must be an object'],
    ['an unknown key', { specSuffix: '.spec.ts' }, 'settings: unknown key "specSuffix"'],
    ['an unknown nested key', { spec: { suffix: [] } }, 'settings.spec: unknown key "suffix"'],
    [
      'a nested section that is not an object',
      { stryker: 'x' },
      'settings.stryker: must be an object',
    ],
    [
      'gateExtensions as a string',
      { gateExtensions: '.ts' },
      'settings.gateExtensions: must be an array of non-empty strings',
    ],
    [
      'an empty gateExtensions',
      { gateExtensions: [] },
      'settings.gateExtensions: must list at least one extension starting with "."',
    ],
    [
      'an extension without a dot',
      { gateExtensions: ['ts'] },
      'settings.gateExtensions: must list at least one extension starting with "."',
    ],
    [
      'a non-string suffix',
      { spec: { suffixes: [1] } },
      'settings.spec.suffixes: must be an array of non-empty strings',
    ],
    [
      'an empty suffix',
      { spec: { suffixes: [''] } },
      'settings.spec.suffixes: must be an array of non-empty strings',
    ],
    ['rewrite as an object', { spec: { rewrite: {} } }, 'settings.spec.rewrite: must be an array'],
    [
      'a rewrite without to',
      { spec: { rewrite: [{ from: 'a' }] } },
      'settings.spec.rewrite[0]: must be { from, to }',
    ],
    [
      'a rewrite without from',
      { spec: { rewrite: [{ to: 'a' }] } },
      'settings.spec.rewrite[0]: must be { from, to }',
    ],
    [
      'a rewrite that is null',
      { spec: { rewrite: [null] } },
      'settings.spec.rewrite[0]: must be { from, to }',
    ],
    [
      'a rewrite with an extra key',
      { spec: { rewrite: [{ from: 'a', to: 'b', flags: 'g' }] } },
      'settings.spec.rewrite[0]: unknown key "flags"',
    ],
    [
      'an invalid rewrite regex',
      { spec: { rewrite: [{ from: '(', to: '' }] } },
      'settings.spec.rewrite[0]: invalid regular expression "("',
    ],
    [
      'defaults as a string',
      { impureImports: { defaults: 'no' } },
      'settings.impureImports.defaults: must be a boolean',
    ],
    [
      'add as a string',
      { impureImports: { add: 'x' } },
      'settings.impureImports.add: must be an array',
    ],
    [
      'an empty pattern string',
      { impureImports: { add: [''] } },
      'settings.impureImports.add[0]: must be a pattern string or { pattern, flags?, reason? }',
    ],
    [
      'a rule without pattern',
      { impurePaths: { add: [{ reason: 'x' }] } },
      'settings.impurePaths.add[0]: must be a pattern string or { pattern, flags?, reason? }',
    ],
    [
      'a rule with an empty pattern',
      { impurePaths: { add: [{ pattern: '' }] } },
      'settings.impurePaths.add[0]: must be a pattern string or { pattern, flags?, reason? }',
    ],
    [
      'a rule with an unknown key',
      { forbiddenSource: { add: [{ pattern: 'x', why: 'y' }] } },
      'settings.forbiddenSource.add[0]: unknown key "why"',
    ],
    [
      'non-string flags',
      { forbiddenSource: { add: [{ pattern: 'x', flags: 1 }] } },
      'settings.forbiddenSource.add[0].flags: must be a string',
    ],
    [
      'a non-string reason',
      { forbiddenSource: { add: [{ pattern: 'x', reason: 1 }] } },
      'settings.forbiddenSource.add[0].reason: must be a string',
    ],
    [
      'an invalid pattern',
      { impureImports: { add: ['['] } },
      'settings.impureImports.add[0]: invalid regular expression "["',
    ],
    [
      'invalid flags',
      { impureImports: { add: [{ pattern: 'a', flags: 'z' }] } },
      'settings.impureImports.add[0]: invalid regular expression "a"',
    ],
    [
      'allow outside impureImports',
      { impurePaths: { allow: ['x'] } },
      'settings.impurePaths: unknown key "allow"',
    ],
    [
      'allow as a string',
      { impureImports: { allow: 'x' } },
      'settings.impureImports.allow: must be an array of non-empty strings',
    ],
    [
      'an invalid allow pattern',
      { impureImports: { allow: ['('] } },
      'settings.impureImports.allow[0]: invalid regular expression "("',
    ],
    [
      'named defaults as a number',
      { impureNamedImports: { defaults: 0 } },
      'settings.impureNamedImports.defaults: must be a boolean',
    ],
    [
      'named add as an object',
      { impureNamedImports: { add: {} } },
      'settings.impureNamedImports.add: must be an array',
    ],
    [
      'a named rule without module',
      { impureNamedImports: { add: [{ names: ['a'] }] } },
      'settings.impureNamedImports.add[0]: must be { module, names, reason? }',
    ],
    [
      'a named rule with an empty module',
      { impureNamedImports: { add: [{ module: '', names: ['a'] }] } },
      'settings.impureNamedImports.add[0]: must be { module, names, reason? }',
    ],
    [
      'a named rule that is a string',
      { impureNamedImports: { add: ['m'] } },
      'settings.impureNamedImports.add[0]: must be { module, names, reason? }',
    ],
    [
      'a named rule without names',
      { impureNamedImports: { add: [{ module: 'm' }] } },
      'settings.impureNamedImports.add[0].names: must be an array of non-empty strings',
    ],
    [
      'a named rule with no name',
      { impureNamedImports: { add: [{ module: 'm', names: [] }] } },
      'settings.impureNamedImports.add[0].names: must list at least one name',
    ],
    [
      'a named rule with an unknown key',
      { impureNamedImports: { add: [{ module: 'm', names: ['a'], x: 1 }] } },
      'settings.impureNamedImports.add[0]: unknown key "x"',
    ],
    [
      'a named rule with a non-string reason',
      { impureNamedImports: { add: [{ module: 'm', names: ['a'], reason: 1 }] } },
      'settings.impureNamedImports.add[0].reason: must be a string',
    ],
    ['aliases as an object', { importAliases: {} }, 'settings.importAliases: must be an array'],
    [
      'an alias without target',
      { importAliases: [{ prefix: '@/' }] },
      'settings.importAliases[0]: must be { prefix, target }',
    ],
    [
      'an alias with an empty prefix',
      { importAliases: [{ prefix: '', target: 'src/' }] },
      'settings.importAliases[0]: must be { prefix, target }',
    ],
    [
      'an alias without prefix',
      { importAliases: [{ target: 'src/' }] },
      'settings.importAliases[0]: must be { prefix, target }',
    ],
    [
      'an alias that is a string',
      { importAliases: ['@/'] },
      'settings.importAliases[0]: must be { prefix, target }',
    ],
    [
      'an alias with an unknown key',
      { importAliases: [{ prefix: '@/', target: 'src/', x: 1 }] },
      'settings.importAliases[0]: unknown key "x"',
    ],
    [
      'gateCommand as a string',
      { gateCommand: 'npx jest' },
      'settings.gateCommand: must be an array of non-empty strings',
    ],
    ['an empty gateCommand', { gateCommand: [] }, 'settings.gateCommand: must not be empty'],
    [
      'an unknown selfcheck mode',
      { selfcheck: { mode: 'some' } },
      'settings.selfcheck.mode: must be "all" or "first"',
    ],
    [
      'an empty failurePattern',
      { selfcheck: { failurePattern: '' } },
      'settings.selfcheck.failurePattern: must be a non-empty string',
    ],
    [
      'an invalid failurePattern',
      { selfcheck: { failurePattern: '{gate}(' } },
      'settings.selfcheck.failurePattern: invalid regular expression "x("',
    ],
    [
      'a non-string configFile',
      { stryker: { configFile: 1 } },
      'settings.stryker.configFile: must be a non-empty string',
    ],
    [
      'an empty reportFile',
      { stryker: { reportFile: '' } },
      'settings.stryker.reportFile: must be a non-empty string',
    ],
    [
      'a non-string lcov file',
      { lcov: { file: [] } },
      'settings.lcov.file: must be a non-empty string',
    ],
    [
      'summaryExclude as a string',
      { lcov: { summaryExclude: 'x' } },
      'settings.lcov.summaryExclude: must be an array of non-empty strings',
    ],
    [
      'an unknown import mode',
      { imports: { mode: 'strict' } },
      'settings.imports.mode: must be "blocklist" or "allowlist"',
    ],
    [
      'an unknown imports key',
      { imports: { transitive: true } },
      'settings.imports: unknown key "transitive"',
    ],
    [
      'imports.allow as a string',
      { imports: { allow: 'x' } },
      'settings.imports.allow: must be an array',
    ],
    [
      'an empty allow entry',
      { imports: { allow: [''] } },
      'settings.imports.allow[0]: must be a package name, { pattern, flags? } or { module, names }',
    ],
    [
      'an allow entry that is a number',
      { imports: { allow: [1] } },
      'settings.imports.allow[0]: must be a package name, { pattern, flags? } or { module, names }',
    ],
    [
      'an allow entry with neither pattern nor module',
      { imports: { allow: [{ names: ['a'] }] } },
      'settings.imports.allow[0]: must be a package name, { pattern, flags? } or { module, names }',
    ],
    [
      'an allow pattern with an unknown key',
      { imports: { allow: [{ pattern: 'a', names: ['a'] }] } },
      'settings.imports.allow[0]: unknown key "names"',
    ],
    [
      'an allow pattern with non-string flags',
      { imports: { allow: [{ pattern: 'a', flags: 1 }] } },
      'settings.imports.allow[0].flags: must be a string',
    ],
    [
      'an invalid allow pattern',
      { imports: { allow: [{ pattern: '(' }] } },
      'settings.imports.allow[0]: invalid regular expression "("',
    ],
    [
      'an allow module without names',
      { imports: { allow: [{ module: 'm' }] } },
      'settings.imports.allow[0].names: must be an array of non-empty strings',
    ],
    [
      'an allow module with no name',
      { imports: { allow: [{ module: 'm', names: [] }] } },
      'settings.imports.allow[0].names: must list at least one name',
    ],
    [
      'an allow module with an unknown key',
      { imports: { allow: [{ module: 'm', names: ['a'], reason: 'x' }] } },
      'settings.imports.allow[0]: unknown key "reason"',
    ],
    [
      'a negative maxTimeouts',
      { mutation: { maxTimeouts: -1 } },
      'settings.mutation.maxTimeouts: must be an integer >= 0',
    ],
    [
      'a fractional maxTimeouts',
      { mutation: { maxTimeouts: 1.5 } },
      'settings.mutation.maxTimeouts: must be an integer >= 0',
    ],
    [
      'maxTimeouts as a string',
      { mutation: { maxTimeouts: '0' } },
      'settings.mutation.maxTimeouts: must be an integer >= 0',
    ],
    [
      'an unknown mutation key',
      { mutation: { maxTimeout: 0 } },
      'settings.mutation: unknown key "maxTimeout"',
    ],
    [
      'an invalid summaryExclude',
      { lcov: { summaryExclude: ['('] } },
      'settings.lcov.summaryExclude[0]: invalid regular expression "("',
    ],
  ])('throws for %s', (_name, raw, expected) => {
    expect(() => resolveSettings(raw)).toThrow(SettingsError);
    try {
      resolveSettings(raw);
    } catch (error) {
      expect((error as Error).message.startsWith(expected)).toBe(true);
    }
  });

  it('accepts an alias with an empty target (the alias points at the project root)', () => {
    expect(
      resolveSettings({ importAliases: [{ prefix: '~/', target: '' }] }).importAliases
    ).toEqual([{ prefix: '~/', target: '' }]);
  });
});
