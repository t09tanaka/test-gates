import type {
  CompiledRule,
  ImportAlias,
  NamedImportRule,
  PatternRule,
  ResolvedSettings,
} from './types.js';

/** Where the Stryker JSON report is written and read when `settings.stryker.reportFile` is not set. */
export const DEFAULT_REPORT_FILE = 'reports/mutation/mutation.json';

export const DEFAULT_GATE_EXTENSIONS = ['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs'];

/**
 * Modules a pure module must not import at runtime. `import type` is never checked.
 * `@prisma/client` is deliberately absent: `Prisma.Decimal` and enums are values a pure
 * module may use. Only `PrismaClient` is banned, through DEFAULT_IMPURE_NAMED_IMPORTS.
 */
export const DEFAULT_IMPURE_IMPORTS: PatternRule[] = [
  { pattern: '^@nestjs/', reason: 'NestJS runtime (DI, decorators)' },
  { pattern: '^class-(validator|transformer)$', reason: 'decorator-based DTO library' },
  {
    pattern: '^(typeorm|sequelize|mongoose|knex|pg|mysql|mysql2|ioredis|redis)(/|$)',
    reason: 'database client',
  },
  { pattern: '^@prisma/adapter-', reason: 'database client' },
  { pattern: '^(react|react-dom)(/|$)', reason: 'React runtime' },
  { pattern: '^next(/|$)', reason: 'Next.js runtime' },
  { pattern: '^(server-only|client-only)$', reason: 'Next.js execution environment' },
  { pattern: '^(vue|vue-router|vue-i18n|pinia)(/|$)', reason: 'Vue runtime' },
  { pattern: '^nuxt(/|$)', reason: 'Nuxt runtime' },
  { pattern: '^#(app|imports)(/|$)', reason: 'Nuxt runtime' },
  { pattern: '\\.vue$', reason: 'component' },
  {
    pattern: '^(express|express-jwt|fastify|koa|rxjs|passport)(/|$)',
    reason: 'HTTP framework runtime',
  },
  { pattern: '^passport-', reason: 'HTTP framework runtime' },
  {
    pattern: '^(axios|openapi-fetch|stripe|nodemailer|firebase-admin)(/|$)',
    reason: 'HTTP client / external service SDK',
  },
  { pattern: '^@(aws-sdk|sentry|slack|stripe)/', reason: 'external service SDK' },
  {
    pattern: '^(node:)?(fs|http|https|http2|net|tls|dgram|dns|child_process|worker_threads)(/|$)',
    reason: 'file system / network / process access',
  },
];

export const DEFAULT_IMPURE_NAMED_IMPORTS: Required<NamedImportRule>[] = [
  { module: '@prisma/client', names: ['PrismaClient'], reason: 'connects to the database' },
];

/** Paths that cannot be gates. */
export const DEFAULT_IMPURE_PATHS: PatternRule[] = [
  { pattern: '\\.(vue|jsx|tsx)$', reason: 'component file' },
  { pattern: '\\.d\\.[cm]?ts$', reason: 'type declaration file' },
];

/** Lines that must not appear in a gate. Each pattern is tested against one line at a time. */
export const DEFAULT_FORBIDDEN_SOURCE: PatternRule[] = [
  {
    pattern: '^\\s*([\'"])use (client|server)\\1',
    reason: "'use client' / 'use server' directive (not a pure module)",
  },
  {
    pattern: '\\bprocess\\.env\\b',
    reason: 'reads process.env (not a pure module). Take the value as an argument',
  },
];

/** Timeouts tolerated outside `expectedTimeouts` when `settings.mutation.maxTimeouts` is not set. */
export const DEFAULT_MAX_TIMEOUTS = 0;

export class SettingsError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function compile(pattern: string, flags: string | undefined, where: string): RegExp {
  try {
    return new RegExp(pattern, flags);
  } catch (error) {
    throw new SettingsError(
      `${where}: invalid regular expression ${JSON.stringify(pattern)} (${(error as Error).message})`
    );
  }
}

function stringArray(value: unknown, where: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item === '')) {
    throw new SettingsError(`${where}: must be an array of non-empty strings`);
  }
  return value as string[];
}

function optionalString(value: unknown, where: string): string | null {
  if (value === undefined) {
    return null;
  }
  if (typeof value !== 'string' || value === '') {
    throw new SettingsError(`${where}: must be a non-empty string`);
  }
  return value;
}

function rejectUnknownKeys(value: Record<string, unknown>, known: string[], where: string): void {
  for (const key of Object.keys(value)) {
    if (!known.includes(key)) {
      throw new SettingsError(`${where}: unknown key ${JSON.stringify(key)}`);
    }
  }
}

function section(value: unknown, known: string[], where: string): Record<string, unknown> {
  if (value === undefined) {
    return {};
  }
  if (!isRecord(value)) {
    throw new SettingsError(`${where}: must be an object`);
  }
  rejectUnknownKeys(value, known, where);
  return value;
}

function compileRules(
  defaults: PatternRule[],
  raw: unknown,
  where: string,
  extraKeys: string[] = []
): { rules: CompiledRule[]; section: Record<string, unknown> } {
  const config = section(raw, ['defaults', 'add', ...extraKeys], where);
  if (config.defaults !== undefined && typeof config.defaults !== 'boolean') {
    throw new SettingsError(`${where}.defaults: must be a boolean`);
  }
  const added = config.add ?? [];
  if (!Array.isArray(added)) {
    throw new SettingsError(`${where}.add: must be an array`);
  }
  const all: { rule: PatternRule; where: string }[] = [];
  if (config.defaults !== false) {
    defaults.forEach((rule) => all.push({ rule, where: `${where} (default)` }));
  }
  added.forEach((item: unknown, index: number) => {
    const at = `${where}.add[${index}]`;
    if (typeof item === 'string' && item !== '') {
      all.push({ rule: { pattern: item }, where: at });
      return;
    }
    if (!isRecord(item) || typeof item.pattern !== 'string' || item.pattern === '') {
      throw new SettingsError(`${at}: must be a pattern string or { pattern, flags?, reason? }`);
    }
    rejectUnknownKeys(item, ['pattern', 'flags', 'reason'], at);
    if (item.flags !== undefined && typeof item.flags !== 'string') {
      throw new SettingsError(`${at}.flags: must be a string`);
    }
    if (item.reason !== undefined && typeof item.reason !== 'string') {
      throw new SettingsError(`${at}.reason: must be a string`);
    }
    all.push({ rule: item as unknown as PatternRule, where: at });
  });
  return {
    rules: all.map(({ rule, where: at }) => ({
      regex: compile(rule.pattern, rule.flags, at),
      reason: rule.reason ?? `matches ${rule.pattern}`,
    })),
    section: config,
  };
}

/**
 * Applies defaults to `settings` of test-gates.json and compiles every pattern.
 * Throws SettingsError on anything it does not understand: a typo in a setting must not
 * silently fall back to a default.
 */
export function resolveSettings(raw: unknown): ResolvedSettings {
  const settings = section(
    raw,
    [
      'gateExtensions',
      'spec',
      'impureImports',
      'impureNamedImports',
      'impurePaths',
      'forbiddenSource',
      'importAliases',
      'gateCommand',
      'selfcheck',
      'stryker',
      'lcov',
      'imports',
      'mutation',
    ],
    'settings'
  );

  const gateExtensions =
    settings.gateExtensions === undefined
      ? DEFAULT_GATE_EXTENSIONS
      : stringArray(settings.gateExtensions, 'settings.gateExtensions');
  if (gateExtensions.length === 0 || gateExtensions.some((ext) => !ext.startsWith('.'))) {
    throw new SettingsError(
      'settings.gateExtensions: must list at least one extension starting with "."'
    );
  }

  const spec = section(settings.spec, ['suffixes', 'rewrite'], 'settings.spec');
  const specSuffixes =
    spec.suffixes === undefined ? null : stringArray(spec.suffixes, 'settings.spec.suffixes');
  const rewriteRaw = spec.rewrite ?? [];
  if (!Array.isArray(rewriteRaw)) {
    throw new SettingsError('settings.spec.rewrite: must be an array');
  }
  const specRewrite = rewriteRaw.map((item: unknown, index: number) => {
    const at = `settings.spec.rewrite[${index}]`;
    if (!isRecord(item) || typeof item.from !== 'string' || typeof item.to !== 'string') {
      throw new SettingsError(`${at}: must be { from, to }`);
    }
    rejectUnknownKeys(item, ['from', 'to'], at);
    return { regex: compile(item.from, undefined, at), to: item.to };
  });

  const imports = compileRules(
    DEFAULT_IMPURE_IMPORTS,
    settings.impureImports,
    'settings.impureImports',
    ['allow']
  );
  const allowedImports =
    imports.section.allow === undefined
      ? []
      : stringArray(imports.section.allow, 'settings.impureImports.allow').map((pattern, index) =>
          compile(pattern, undefined, `settings.impureImports.allow[${index}]`)
        );

  const named = section(
    settings.impureNamedImports,
    ['defaults', 'add'],
    'settings.impureNamedImports'
  );
  if (named.defaults !== undefined && typeof named.defaults !== 'boolean') {
    throw new SettingsError('settings.impureNamedImports.defaults: must be a boolean');
  }
  const namedAdd = named.add ?? [];
  if (!Array.isArray(namedAdd)) {
    throw new SettingsError('settings.impureNamedImports.add: must be an array');
  }
  const impureNamedImports: Required<NamedImportRule>[] = [
    ...(named.defaults === false ? [] : DEFAULT_IMPURE_NAMED_IMPORTS),
    ...namedAdd.map((item: unknown, index: number) => {
      const at = `settings.impureNamedImports.add[${index}]`;
      if (!isRecord(item) || typeof item.module !== 'string' || item.module === '') {
        throw new SettingsError(`${at}: must be { module, names, reason? }`);
      }
      rejectUnknownKeys(item, ['module', 'names', 'reason'], at);
      const names = stringArray(item.names, `${at}.names`);
      if (names.length === 0) {
        throw new SettingsError(`${at}.names: must list at least one name`);
      }
      if (item.reason !== undefined && typeof item.reason !== 'string') {
        throw new SettingsError(`${at}.reason: must be a string`);
      }
      return {
        module: item.module,
        names,
        reason: (item.reason as string | undefined) ?? 'not allowed in a pure module',
      };
    }),
  ];

  const aliasesRaw = settings.importAliases ?? [];
  if (!Array.isArray(aliasesRaw)) {
    throw new SettingsError('settings.importAliases: must be an array');
  }
  const importAliases: ImportAlias[] = aliasesRaw.map((item: unknown, index: number) => {
    const at = `settings.importAliases[${index}]`;
    if (
      !isRecord(item) ||
      typeof item.prefix !== 'string' ||
      item.prefix === '' ||
      typeof item.target !== 'string'
    ) {
      throw new SettingsError(`${at}: must be { prefix, target }`);
    }
    rejectUnknownKeys(item, ['prefix', 'target'], at);
    return { prefix: item.prefix, target: item.target };
  });

  let gateCommand: string[] | null = null;
  if (settings.gateCommand !== undefined) {
    gateCommand = stringArray(settings.gateCommand, 'settings.gateCommand');
    if (gateCommand.length === 0) {
      throw new SettingsError('settings.gateCommand: must not be empty');
    }
  }

  const selfcheck = section(settings.selfcheck, ['mode', 'failurePattern'], 'settings.selfcheck');
  if (selfcheck.mode !== undefined && selfcheck.mode !== 'all' && selfcheck.mode !== 'first') {
    throw new SettingsError('settings.selfcheck.mode: must be "all" or "first"');
  }
  const selfcheckFailurePattern = optionalString(
    selfcheck.failurePattern,
    'settings.selfcheck.failurePattern'
  );
  if (selfcheckFailurePattern !== null) {
    compile(
      selfcheckFailurePattern.split('{gate}').join('x'),
      undefined,
      'settings.selfcheck.failurePattern'
    );
  }

  const importsSection = section(settings.imports, ['mode', 'allow'], 'settings.imports');
  if (
    importsSection.mode !== undefined &&
    importsSection.mode !== 'blocklist' &&
    importsSection.mode !== 'allowlist'
  ) {
    throw new SettingsError('settings.imports.mode: must be "blocklist" or "allowlist"');
  }
  const importAllowRaw = importsSection.allow ?? [];
  if (!Array.isArray(importAllowRaw)) {
    throw new SettingsError('settings.imports.allow: must be an array');
  }
  const importAllow = importAllowRaw.map((item: unknown, index: number) => {
    const at = `settings.imports.allow[${index}]`;
    if (typeof item === 'string' && item !== '') {
      return { module: item };
    }
    if (isRecord(item) && typeof item.pattern === 'string' && item.pattern !== '') {
      rejectUnknownKeys(item, ['pattern', 'flags'], at);
      if (item.flags !== undefined && typeof item.flags !== 'string') {
        throw new SettingsError(`${at}.flags: must be a string`);
      }
      return { regex: compile(item.pattern, item.flags as string | undefined, at) };
    }
    if (isRecord(item) && typeof item.module === 'string' && item.module !== '') {
      rejectUnknownKeys(item, ['module', 'names'], at);
      const names = stringArray(item.names, `${at}.names`);
      if (names.length === 0) {
        throw new SettingsError(`${at}.names: must list at least one name`);
      }
      return { module: item.module, names };
    }
    throw new SettingsError(
      `${at}: must be a package name, { pattern, flags? } or { module, names }`
    );
  });

  const mutation = section(settings.mutation, ['maxTimeouts'], 'settings.mutation');
  if (
    mutation.maxTimeouts !== undefined &&
    !(Number.isInteger(mutation.maxTimeouts) && (mutation.maxTimeouts as number) >= 0)
  ) {
    throw new SettingsError('settings.mutation.maxTimeouts: must be an integer >= 0');
  }

  const stryker = section(settings.stryker, ['configFile', 'reportFile'], 'settings.stryker');
  const lcov = section(settings.lcov, ['file', 'summaryExclude'], 'settings.lcov');

  return {
    gateExtensions,
    specSuffixes,
    specRewrite,
    impureImports: imports.rules,
    allowedImports,
    impureNamedImports,
    impurePaths: compileRules(DEFAULT_IMPURE_PATHS, settings.impurePaths, 'settings.impurePaths')
      .rules,
    forbiddenSource: compileRules(
      DEFAULT_FORBIDDEN_SOURCE,
      settings.forbiddenSource,
      'settings.forbiddenSource'
    ).rules,
    importAliases,
    gateCommand,
    selfcheckMode: (selfcheck.mode as 'all' | 'first' | undefined) ?? 'all',
    selfcheckFailurePattern,
    strykerConfigFile: optionalString(stryker.configFile, 'settings.stryker.configFile'),
    strykerReportFile:
      optionalString(stryker.reportFile, 'settings.stryker.reportFile') ?? DEFAULT_REPORT_FILE,
    importMode: (importsSection.mode as 'blocklist' | 'allowlist' | undefined) ?? 'blocklist',
    importAllow,
    maxTimeouts: (mutation.maxTimeouts as number | undefined) ?? DEFAULT_MAX_TIMEOUTS,
    lcovFile: optionalString(lcov.file, 'settings.lcov.file'),
    lcovSummaryExclude:
      lcov.summaryExclude === undefined
        ? []
        : stringArray(lcov.summaryExclude, 'settings.lcov.summaryExclude').map((pattern, index) =>
            compile(pattern, undefined, `settings.lcov.summaryExclude[${index}]`)
          ),
  };
}
