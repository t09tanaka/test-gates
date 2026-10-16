import fs from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';
import { gateDependencies, kindOf } from './core/affected.js';
import { isProjectImport } from './core/import-policy.js';
import { findUncheckableImports, type ImportRef, parseImports } from './core/imports.js';
import {
  COMPONENT,
  installed,
  QUOTED,
  resolveFiles,
  RUNNER_LOAD,
  SCRIPT,
} from './commands/loaded-files.js';
import type { ImportAlias } from './core/types.js';
import type { LoadedManifest } from './load.js';

/** Thrown when what a gate depends on cannot be told from the text of the files. */
export class AffectedError extends Error {}

/**
 * What lets a file read other files, or load modules, in a way that its imports do not show.
 * Where one of them is used, a change to a file that nothing imports could change a result.
 */
const RUNTIME_PATHS =
  /\b(?:require\.(?:context|resolve)|process\.cwd|createRequire|toMatchFileSnapshot|readFileSync|readdirSync)\b|\bimport\.meta\.(?:glob|resolve)\b/;
/**
 * Where the file itself lies. Knowing it reads nothing: `path.join(__dirname, '..', '.env')` is
 * only a string. It is what the file does with it that may read a file (see LOCATION_READS).
 */
const LOCATION = /\b(?:__dirname|__filename)\b|\bimport\.meta\.(?:url|dirname|filename)\b/;
/**
 * What, next to LOCATION, may read a file by that path, besides what is refused anyway (an
 * import of fs, a computed import, RUNTIME_PATHS): a function that reads, opens or looks at a
 * file or a directory, a module handed to the runner by a computed path
 * (`vi.mock(join(__dirname, 'rates'))`), and a worker started from a file.
 */
const LOCATION_READS =
  /\b(?:readFile|readdir|readlink|existsSync|stat|statSync|lstat|lstatSync|access|accessSync|realpath|realpathSync|open|openSync|opendir|opendirSync|createReadStream|watch|watchFile|glob|globSync|promises)\b|\b(?:requireActual|requireMock|importActual|importMock|mock|doMock|unstable_mockModule|setMock|createMockFromModule)\(\s*(?![\s'"`)])|\bWorker\(/;
/**
 * Modules that a file may import next to LOCATION without reading by it: those that only build
 * paths and URLs, and the test runner's own. Any other package or built-in module counts as one
 * that reads for the file (`config({ path: join(__dirname, '..', '.env') })` of dotenv): a
 * package is not looked into, so what it does with a path cannot be told.
 */
const LOCATION_SAFE = new Set([
  'path',
  'path/posix',
  'path/win32',
  'url',
  'vitest',
  '@jest/globals',
]);
const FILE_MODULES = new Set([
  'fs',
  'fs/promises',
  'child_process',
  'module',
  'worker_threads',
  'fs-extra',
  'graceful-fs',
  'glob',
  'fast-glob',
  'globby',
]);
const bare = (specifier: string): string => specifier.replace(/^node:/, '');

/**
 * Where `node_modules/<package>` of the nearest node_modules that has it leads, when that is a
 * link to a directory outside of every node_modules (a package of the same repository); else null.
 */
export function linkedPackage(specifier: string, from: string): string | null {
  const name = specifier
    .split('/')
    .slice(0, specifier.startsWith('@') ? 2 : 1)
    .join('/');
  for (let current = path.dirname(from); ; current = path.dirname(current)) {
    const candidate = path.join(current, 'node_modules', name);
    if (fs.existsSync(candidate)) {
      const target = realpath(candidate);
      return target.split(path.sep).includes('node_modules') ? null : target;
    }
    if (current === path.dirname(current)) {
      return null;
    }
  }
}

const toPosix = (file: string): string => file.split(path.sep).join('/');

/** The path as it is on disk, also in the case of its letters (what git and a listing show). */
function realpath(file: string): string {
  try {
    return fs.realpathSync.native(file);
  } catch {
    return file;
  }
}

/** The configs of a run: the Stryker config and the config of its test runner. */
export interface RunConfigs {
  /** Absolute paths that exist. */
  files: string[];
  /** The test runner; when it is not known, imports of types are followed (see typesErased). */
  runner?: 'jest' | 'vitest';
  /** Whether the Stryker config names checkers (`checkers: ['typescript']`). */
  checkers?: boolean;
}

/** Where the config of the test runner is, from the options the Stryker config gives it. */
export function runnerConfigs(
  dir: string,
  stryker: string,
  options: {
    testRunner?: unknown;
    vitestConfig?: unknown;
    jestConfig?: unknown;
    checkers?: unknown;
  }
): RunConfigs {
  const files = [path.resolve(dir, stryker)];
  const named = options.testRunner === 'vitest' ? options.vitestConfig : options.jestConfig;
  if (options.testRunner !== 'vitest' && options.testRunner !== 'jest') {
    throw new AffectedError(
      `--affected knows the test runners jest and vitest, the Stryker config uses ${String(options.testRunner)}`
    );
  }
  if (typeof named === 'string') {
    files.push(path.resolve(dir, named));
  } else {
    const names =
      options.testRunner === 'vitest' ? ['vitest.config', 'vite.config'] : ['jest.config'];
    for (const name of names) {
      for (const extension of ['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs', '.json']) {
        const file = path.join(dir, name + extension);
        if (fs.existsSync(file)) {
          files.push(file);
        }
      }
    }
  }
  return {
    files: files.filter((file) => fs.existsSync(file)).map(realpath),
    runner: options.testRunner,
    checkers: Array.isArray(options.checkers) && options.checkers.length > 0,
  };
}

/** Whether the run takes imports of types into account; see typesErased. */
export interface TypeImports {
  /** `import type …` and `export type … from` load nothing. */
  erased: boolean;
  /** `import { type A } from …` loads nothing either. */
  inline: boolean;
}

/** Words in a config that may make a run check types. */
const CHECKS_TYPES = /\bcheckers\b|typescript-checker|\btypecheck\b/;
/** Options of ts-jest that make it only strip types, without checking them. */
const TS_JEST_STRIPS = /["']?(?:isolatedModules["']?\s*:\s*true|diagnostics["']?\s*:\s*false)/;
/**
 * What makes an option of ts-jest above not hold for every spec: projects of their own, or
 * compiler options given in place (where `isolatedModules` is not an option of ts-jest).
 */
const TS_JEST_UNSURE = /\b(?:projects|compilerOptions)\b|\btsconfig["']?\s*:\s*\{/;
/** Jest transforms that only strip types. */
const STRIPPING_TRANSFORMS = /@swc\/jest|babel-jest|esbuild-jest|@sucrase\/jest/;
/** Options that make the compiler keep an import of type names (as `import {} from …`). */
const KEEPS_IMPORTS =
  /\b(?:verbatimModuleSyntax|preserveValueImports|importsNotUsedAsValues|onlyRemoveTypeImports)\b/;
/** Files that tell the compiler what to do with imports. */
const COMPILER_CONFIG =
  /^(?:[jt]sconfig(?:\..+)?\.json|\.swcrc|\.babelrc(?:\..+)?|babel\.config\..+)$/;

/**
 * Whether a run never loads what a gate or a spec imports for its types only. Such an import is
 * dropped by the compiler, so a change of the file it names cannot change a result, unless the
 * run checks types: then a change of a type can make a spec, or a mutant, fail to compile.
 * In doubt the imports are kept (followed, as a file the gate depends on).
 *
 * - The TypeScript checker of Stryker checks every mutant: kept.
 * - Vitest strips types (esbuild), unless its typecheck is on: kept where a config names it.
 * - Jest: ts-jest checks types unless `isolatedModules: true` or `diagnostics: false`. Another
 *   transform (`@swc/jest`, `babel-jest`) strips them, but a preset may bring ts-jest. With
 *   nothing of this in its config, what transforms the specs is not known: kept.
 *
 * `import { type A } from './a'` is still loaded, as `import {} from './a'`, where the compiler
 * keeps imports as they are written (`verbatimModuleSyntax`): it is dropped only when a
 * tsconfig.json tells, with every file it extends, that they are not kept.
 *
 * @param texts The Stryker config, the runner config, and the files they import.
 * @param compiler The tsconfig.json, .swcrc and Babel configs that apply to the subproject, with
 *   what they extend; the text is null where one extends a file that cannot be read.
 */
export function typesErased(
  configs: RunConfigs,
  texts: string[],
  compiler: Array<{ file: string; text: string | null }>
): TypeImports {
  // Not what a comment says: `// isolatedModules: true would be faster`.
  const all = texts.map(withoutComments).join('\n');
  let erased = false;
  if (configs.checkers !== true && !CHECKS_TYPES.test(all)) {
    if (configs.runner === 'vitest') {
      erased = true;
    } else if (configs.runner === 'jest') {
      erased = /\bts-jest\b/.test(all)
        ? TS_JEST_STRIPS.test(all) && !TS_JEST_UNSURE.test(all)
        : STRIPPING_TRANSFORMS.test(all) && !/\bpreset\b/.test(all);
    }
  }
  const inline =
    erased &&
    !KEEPS_IMPORTS.test(all) &&
    compiler.some(({ file }) => /^tsconfig/.test(path.basename(file))) &&
    compiler.every(({ text }) => text !== null && !KEEPS_IMPORTS.test(text));
  return { erased, inline };
}

/**
 * The compiler configs that apply to the subproject: those in it, and the tsconfig.json files of
 * the directories above it up to the root, with every file they extend.
 */
function compilerConfigs(
  dir: string,
  root: string,
  keys: string[]
): Array<{ file: string; text: string | null }> {
  const above = new Set<string>();
  for (let current = path.dirname(dir); ; current = path.dirname(current)) {
    const relative = path.relative(root, current);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      break;
    }
    above.add(current);
    if (current === path.dirname(current)) {
      break;
    }
  }
  const compared = new Set(keys.map((key) => path.join(root, key)));
  // package.json may hold a Babel config (`"babel": { … }`).
  const starts = [...compared].filter(
    (file) =>
      (COMPILER_CONFIG.test(path.basename(file)) || path.basename(file) === 'package.json') &&
      (file.startsWith(`${dir}${path.sep}`) || above.has(path.dirname(file)))
  );
  const found: Array<{ file: string; text: string | null }> = [];
  const seen = new Set<string>();
  const queue = [...starts];
  for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
    if (seen.has(file)) {
      continue;
    }
    seen.add(file);
    // A base that is not compared (generated, ignored by git) can change without the snapshot
    // showing it: taken as one that cannot be read. One that is installed is compared through
    // the lock file.
    let text: string | null = null;
    if (compared.has(file) || file.split(path.sep).includes('node_modules')) {
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch {
        text = null;
      }
    }
    found.push({ file, text });
    for (const base of text === null ? [] : valuesOf(text, 'extends')) {
      queue.push(extended(base, file) ?? `${file} extends ${base}`);
    }
  }
  return found;
}

/** The file a config extends (`./tsconfig.base.json`, `@acme/tsconfig/base.json`), or null. */
function extended(base: string, from: string): string | null {
  const candidates = (start: string): string[] => [
    start,
    `${start}.json`,
    path.join(start, 'tsconfig.json'),
  ];
  if (base.startsWith('.') || path.isAbsolute(base)) {
    return candidates(path.resolve(path.dirname(from), base)).find(isFile) ?? null;
  }
  for (let current = path.dirname(from); ; current = path.dirname(current)) {
    const file = candidates(path.join(current, 'node_modules', base)).find(isFile);
    if (file !== undefined) {
      return file;
    }
    if (current === path.dirname(current)) {
      return null;
    }
  }
}

function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

export interface Edges {
  /** Project files the file loads. */
  loads: string[];
  /** Why what the file loads cannot be told, or null. */
  unknown: string | null;
  /** Whether the file loads modules that are not followed: a path not written out, or a linked package. */
  computed: boolean;
  /** Imports that are neither a file nor an installed package: aliases this tool is not told of. */
  unnamed: string[];
}

/**
 * What a file loads, as far as its text shows: its imports, paths it hands to the runner as text
 * (`vi.mock('./rates')`), and its snapshot file.
 *
 * @param context.dir The subproject, the start of the paths of aliases.
 * @param context.cache What is known of each file already.
 */
export function fileEdges(
  file: string,
  context: { dir: string; aliases: ImportAlias[]; cache: Map<string, Edges>; types?: TypeImports }
): Edges {
  const { dir, aliases, cache, types } = context;
  const known = cache.get(file);
  if (known !== undefined) {
    return known;
  }
  const shown = (one: string): string => toPosix(path.relative(dir, one));
  const target = (specifier: string, from: string): string[] => {
    if (specifier.startsWith('.')) {
      return resolveFiles(path.resolve(path.dirname(from), specifier));
    }
    const alias = aliases.find((candidate) => specifier.startsWith(candidate.prefix));
    return alias === undefined
      ? []
      : resolveFiles(path.resolve(dir, alias.target + specifier.slice(alias.prefix.length)));
  };
  const found: Edges = { loads: [], unknown: null, computed: false, unnamed: [] };
  cache.set(file, found);
  const snapshotFile = path.join(
    path.dirname(file),
    '__snapshots__',
    `${path.basename(file)}.snap`
  );
  if (fs.existsSync(snapshotFile)) {
    found.loads.push(realpath(snapshotFile));
  }
  if (!SCRIPT.test(file) && !COMPONENT.test(file)) {
    return found; // data: it loads nothing
  }
  // A component imports in its scripts (or the frontmatter of Astro): read as one text. What its
  // template uses without an import (a component registered by a plugin) is not seen, so that
  // --affected runs every mutant for it.
  const source = fs.readFileSync(file, 'utf8');
  if (COMPONENT.test(file)) {
    found.unknown = `${shown(file)} is a component, which can use others that it does not import`;
  }
  const uncheckable = findUncheckableImports(source)[0];
  const runtime = RUNTIME_PATHS.exec(source);
  if (uncheckable !== undefined) {
    found.unknown = `${shown(file)}:${uncheckable} imports a module whose path is not written out`;
    found.computed = true;
  } else if (runtime !== null) {
    found.unknown = `${shown(file)} uses ${runtime[0]}, which can reach files that no import names`;
  }
  const location = LOCATION.exec(source);
  // An import of types only, where the run drops it (see typesErased), loads nothing; a module
  // that is also imported for a value, or named to the runner, is still followed.
  const refs = parseImports(source);
  const dropped = (ref: ImportRef): boolean =>
    types !== undefined &&
    types.erased &&
    (ref.typeOnly || (types.inline && ref.inlineTypes === true));
  const specifiers = new Set([
    ...refs.filter((ref) => !dropped(ref)).map((ref) => ref.module),
    ...[...source.matchAll(RUNNER_LOAD)].map((match) => match[2] as string),
  ]);
  const typesOnly = new Set(
    refs
      .filter(dropped)
      .map((ref) => ref.module)
      .filter((module) => !specifiers.has(module))
  );
  for (const specifier of specifiers) {
    if (path.isAbsolute(specifier) || specifier.startsWith('file:')) {
      const resolved = resolveFiles(
        specifier.startsWith('file:') ? new URL(specifier).pathname : specifier
      );
      if (resolved.length === 0) {
        found.unknown ??= `${shown(file)} imports ${specifier}, which leads to no file`;
      } else {
        found.loads.push(...resolved.map(realpath));
      }
    } else if (isProjectImport(specifier, aliases)) {
      const resolved = target(specifier, file);
      if (resolved.length === 0) {
        found.unknown ??= `${shown(file)} imports ${specifier}, which leads to no file`;
      } else {
        found.loads.push(...resolved.map(realpath));
      }
    } else if (FILE_MODULES.has(bare(specifier))) {
      found.unknown ??= `${shown(file)} imports ${specifier}, which can reach files that no import names`;
    } else if (!specifier.startsWith('node:') && !builtinModules.includes(specifier)) {
      if (!installed(specifier, file)) {
        found.unknown ??= `${shown(file)} imports ${specifier}, which is neither a file nor an installed package (name an alias in settings.importAliases)`;
        found.unnamed.push(specifier);
      } else if (linkedPackage(specifier, file) !== null) {
        // A package of the repository, linked into node_modules: its files are not followed.
        found.unknown ??= `${shown(file)} imports ${specifier}, a package of the repository linked into node_modules`;
        found.computed = true;
      }
    }
  }
  if (location !== null) {
    const reads = LOCATION_READS.exec(source);
    const reader = [...specifiers].find(
      (specifier) =>
        !specifier.startsWith('.') &&
        !path.isAbsolute(specifier) &&
        !specifier.startsWith('file:') &&
        !isProjectImport(specifier, aliases) &&
        !LOCATION_SAFE.has(bare(specifier))
    );
    if (reads !== null) {
      found.unknown ??= `${shown(file)} uses ${location[0]} and ${reads[0].replace(/\(\s*$/, '')}, which can reach files that no import names`;
    } else if (reader !== undefined) {
      found.unknown ??= `${shown(file)} uses ${location[0]} and imports ${reader}, which can read files by it that no import names`;
    }
  }
  // A path given to the runner as text: vi.mock('./rates', …).
  for (const match of source.matchAll(QUOTED)) {
    const text = match[2] as string;
    if (text.startsWith('.') && !specifiers.has(text) && !typesOnly.has(text)) {
      found.loads.push(...resolveFiles(path.resolve(path.dirname(file), text)).map(realpath));
    }
  }
  return found;
}

/**
 * Builds the inputs of core/affected.ts from the files on disk.
 *
 * @param input.root The directory the keys of the snapshot are relative to.
 * @param input.files The files of the snapshot, by key.
 * @param input.configs The Stryker config and the test runner config.
 * @param input.tests Spec files of the last run, relative to the subproject.
 * @param input.covering For each gate (as in test-gates.json): the specs, relative to the
 *   subproject, whose tests covered or killed one of its mutants.
 * @throws AffectedError when what a gate depends on cannot be told.
 */
export function affectedInputs(
  manifest: LoadedManifest,
  input: {
    root: string;
    files: Record<string, string>;
    configs: RunConfigs;
    tests: string[];
    covering: Record<string, string[]>;
  }
): {
  subproject: string;
  config: string[];
  /** By gate as in test-gates.json. */
  gates: Record<string, { key: string; specs: string[]; files: string[] }>;
} {
  const dir = realpath(manifest.dir);
  const aliases = manifest.settings.importAliases;
  // The report names its spec files relative to the subproject; anything else cannot be placed.
  const placed = [...input.tests, ...Object.values(input.covering).flat()];
  const absolute = placed.find((file) => path.isAbsolute(file) || file.startsWith('..'));
  if (absolute !== undefined) {
    throw new AffectedError(`the report names a spec file outside of the subproject: ${absolute}`);
  }
  const keyOf = (file: string): string => {
    const relative = path.relative(input.root, realpath(file));
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new AffectedError(`${file} is outside of the files that are compared`);
    }
    return toPosix(relative);
  };
  const shown = (file: string): string => toPosix(path.relative(dir, file));
  // The texts of the configs and of what they import, read before imports of types are dropped.
  const plain = new Map<string, Edges>();
  const configTexts: string[] = [];
  const reached = new Set(input.configs.files);
  const pending = [...input.configs.files];
  for (let file = pending.shift(); file !== undefined; file = pending.shift()) {
    configTexts.push(fs.readFileSync(file, 'utf8'));
    for (const next of fileEdges(file, { dir, aliases, cache: plain }).loads) {
      if (!reached.has(next) && SCRIPT.test(next)) {
        reached.add(next);
        pending.push(next);
      }
    }
  }
  const types = typesErased(
    input.configs,
    configTexts,
    compilerConfigs(dir, realpath(input.root), Object.keys(input.files))
  );
  const edges = new Map<string, Edges>();
  const edgesOf = (file: string): Edges => fileEdges(file, { dir, aliases, cache: edges, types });
  /** The file and what it loads, directly or not. */
  const closure = (start: string, strict: boolean): string[] => {
    const seen = new Set([start]);
    const queue = [start];
    for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
      const found = edgesOf(file);
      if (strict && found.unknown !== null) {
        throw new AffectedError(found.unknown);
      }
      for (const next of found.loads) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    return [...seen];
  };
  const isCompared = (file: string): boolean => {
    const relative = path.relative(input.root, realpath(file));
    return (
      !relative.startsWith('..') && !path.isAbsolute(relative) && toPosix(relative) in input.files
    );
  };
  const keysOf = (files: string[]): string[] =>
    files.map((file) => {
      const key = keyOf(file);
      if (!(key in input.files)) {
        throw new AffectedError(
          `${shown(file)} is loaded by a gate or a spec, but is not among the compared files (does git ignore it?)`
        );
      }
      return key;
    });

  // The configs, what they import, and the files they name (setup files, mocks, environments):
  // those are loaded for every spec.
  // What lies outside of the compared files (this package, imported by path) is installed.
  const config = new Set<string>();
  const named: string[] = [];
  for (const file of input.configs.files) {
    for (const loaded of closure(file, false).filter(isCompared)) {
      config.add(loaded);
      if (!SCRIPT.test(loaded)) {
        continue;
      }
      for (const match of fs.readFileSync(loaded, 'utf8').matchAll(QUOTED)) {
        const text = (match[2] as string).replace(/^<rootDir>\//, '');
        const here = resolveFiles(path.resolve(path.dirname(loaded), text), false, false);
        const candidates =
          here.length > 0 ? here : resolveFiles(path.resolve(dir, text), false, false);
        for (const found of candidates) {
          if (text.includes('*') || !isCompared(found)) {
            continue;
          }
          if (SCRIPT.test(found)) {
            // A setup file, an environment, a reporter: run for every spec.
            named.push(realpath(found));
          } else {
            // Not run, but maybe read for every spec (`moduleNameMapper` to a JSON or a stub), or
            // not at all (`coverage.exclude: ['src/Widget.vue']`). Either way a change of it
            // reruns every gate. What a component imports is not followed from here: it is not
            // run for every spec, and it cannot stop the gates from being told apart, as it would
            // when followed as strictly as a setup file.
            config.add(realpath(found));
          }
        }
      }
    }
  }
  const gatePaths = new Map(
    manifest.gates.map((gate) => [realpath(path.join(dir, gate.path)), gate.path])
  );
  const tests = [
    ...new Set([
      ...input.tests,
      ...manifest.gates.flatMap((gate) => gate.existingSpecs),
      ...Object.values(input.covering).flat(),
    ]),
  ];
  // A spec or a gate that a config names is run as one, not for every spec.
  const runAsSuch = new Set(
    [...tests, ...manifest.gates.map((gate) => gate.path)].map((file) =>
      realpath(path.join(dir, file))
    )
  );
  // A setup file runs in every spec: what it loads is checked as strictly as what a spec loads.
  // A config it names (one put together from parts) is not.
  const subprojectKey = toPosix(path.relative(input.root, dir));
  const isConfig = (file: string): boolean =>
    input.configs.files.includes(file) || kindOf(keyOf(file), subprojectKey) === 'config';
  for (const file of named.filter((one) => !isConfig(one) && !runAsSuch.has(one))) {
    for (const loaded of closure(file, true)) {
      const gate = gatePaths.get(loaded);
      if (gate !== undefined) {
        throw new AffectedError(
          `${gate} is loaded through the test runner config for every spec (${shown(file)})`
        );
      }
      config.add(loaded);
    }
  }

  const fromSubproject = (file: string): string => path.join(dir, file);
  const closures = Object.create(null) as Record<string, string[]>;
  for (const file of [...manifest.gates.map((gate) => gate.path), ...tests]) {
    const absolute = fromSubproject(file);
    if (!fs.existsSync(absolute)) {
      continue; // a spec that is gone: its key is compared, and has changed
    }
    closures[keysOf([absolute])[0] as string] = keysOf(closure(realpath(absolute), true));
  }
  const keyed = (files: string[]): string[] =>
    files.map((file) => toPosix(path.relative(input.root, path.join(dir, file))));
  const dependencies = gateDependencies({
    gates: manifest.gates.map((gate) => ({
      key: keyed([gate.path])[0] as string,
      specs: keyed(gate.existingSpecs),
    })),
    tests: keyed(tests),
    covering: Object.fromEntries(
      Object.entries(input.covering).map(([gate, specs]) => [keyed([gate])[0], keyed(specs)])
    ),
    closures,
  });
  const subproject = toPosix(path.relative(input.root, dir));
  const prefix = subproject === '' ? '' : `${subproject}/`;
  const gates = Object.create(null) as Record<
    string,
    { key: string; specs: string[]; files: string[] }
  >;
  for (const gate of manifest.gates) {
    const key = keyed([gate.path])[0] as string;
    const found = dependencies[key] as { specs: string[]; files: string[] };
    gates[gate.path] = {
      key,
      specs: found.specs.map((spec) =>
        spec.startsWith(prefix) ? spec.slice(prefix.length) : spec
      ),
      files: found.files,
    };
  }
  return { subproject, config: keysOf([...config]).sort(), gates };
}

/** Why every file is followed when the runner config is not made with the helpers. */
export const NOT_THE_HELPER =
  'the runner config is not made with createJestGatesConfig or createVitestGatesConfig';
/** A runner config made with the helpers of this tool. */
const OWN = /@t09tanaka\/test-gates\/(?:jest|vitest)\b/;
/** Options that make a runner config of the helpers run more than the specs of the gates. */
const PROJECTS = /\b(?:projects|workspace)\b/;
const HELPERS = ['createJestGatesConfig', 'createVitestGatesConfig'];

/**
 * Whether what a runner config exports is what a helper returns: `export default helper(…)`,
 * `module.exports = helper(…)`, also inside `defineConfig(…)`, by another name it is imported
 * under, or through a variable that is exported as it is.
 */
function isHelperResult(text: string): boolean {
  const names = new Set(HELPERS);
  for (const match of text.matchAll(
    /\b(?:createJestGatesConfig|createVitestGatesConfig)\s*(?::|\bas\b)\s*([\w$]+)/g
  )) {
    names.add(match[1] as string);
  }
  const escape = (name: string): string => name.replace(/\$/g, '\\$');
  const call = `(?:defineConfig\\s*\\(\\s*)?(?:${[...names].map(escape).join('|')})\\s*\\(`;
  const exported = '(?:export\\s+default|module\\.exports\\s*=)\\s*';
  // What is exported is reached again after it is set: `module.exports.testMatch = …`.
  const reached = (name: string): boolean =>
    new RegExp(`\\b${escape(name)}\\s*(?:\\.|\\[)`).test(text);
  if (new RegExp(`${exported}${call}`).test(text)) {
    return (
      !reached('module.exports') &&
      !/\bexports\s*(?:\.|\[)/.test(text.replace(/\bmodule\.exports\s*=/g, ''))
    );
  }
  const variable = new RegExp(`\\b(?:const|let|var)\\s+([\\w$]+)\\s*=\\s*${call}`).exec(text);
  if (variable === null) {
    return false;
  }
  // The variable is named twice and no more: where it is set, and where it is exported. Any other
  // use (`Object.assign(config, …)`, `config = mergeConfig(config, …)`) may change it.
  const name = escape(variable[1] as string);
  const uses = text.match(new RegExp(`(?<![\\w$.])${name}(?![\\w$])`, 'g')) ?? [];
  return uses.length === 2 && new RegExp(`${exported}${name}\\s*(?:;|$)`, 'm').test(text);
}

/**
 * Files the tools of a run read by their names, at the top of the subproject. Not package.json:
 * with a runner config of the helpers, what it holds for the runner is not read, and its scripts
 * name paths that the run does not use.
 */
const READ_BY_NAME = [
  /^test-gates\.json$/,
  /^[jt]sconfig(?:\..+)?\.json$/,
  /^babel\.config\.[cm]?[jt]s(?:on)?$/,
  /^\.babelrc(?:\.[cm]?js(?:on)?)?$/,
  /^\.swcrc$/,
];

/**
 * The files of the subproject that a mutation run loads, as far as their text shows: the
 * configs, the gates and their specs, what tools read by name, and everything those load. The
 * snapshot follows the paths in these files only (see snapshot.ts); the other files of the
 * subproject are compared, but cannot point the run anywhere.
 *
 * An import of an alias that settings.importAliases does not name (one a runner config maps)
 * leads to every file of the subproject whose path ends as the import does: `@shared/money/fee`
 * to `src/money/fee.ts`, `lib/money/fee/index.ts`. Where none does, it leads out of the
 * subproject, to a place that the config that maps it names.
 *
 * @param configs The Stryker config and the config of the test runner.
 * @param listed The files of the subproject, as absolute paths.
 * @returns `every`, with the reason, when the specs the run starts are not known, or when a file
 *   loads modules that are not followed: then every file is followed.
 */
export function loadedScope(
  manifest: LoadedManifest,
  configs: RunConfigs,
  listed: string[]
): { files: Set<string> } | { every: string } {
  const dir = realpath(manifest.dir);
  const cache = new Map<string, Edges>();
  const context = { dir, aliases: manifest.settings.importAliases, cache };
  // Only a config that is what a helper of this tool returns runs the specs of the gates and no
  // others: the helper sets them after the options it is given. Not one that changes what the
  // helper returns (merged with another config, spread with more after it), and not one given
  // projects of its own, which the helper passes on, also from a file it is put together from.
  const runner = configs.files.slice(1);
  const texts = runner.map((file) => withoutComments(fs.readFileSync(file, 'utf8')));
  if (runner.length === 0 || !texts.every((text) => OWN.test(text))) {
    return { every: NOT_THE_HELPER };
  }
  if (!texts.every(isHelperResult)) {
    return {
      every:
        'what the runner config exports is not what the helper returns (merged with another config, or changed after the call)',
    };
  }
  const parts = new Set(runner.map(realpath));
  for (const file of [...parts]) {
    if (SCRIPT.test(file)) {
      fileEdges(file, context).loads.forEach((loaded) => parts.add(loaded));
    }
  }
  if ([...parts].some((file) => PROJECTS.test(withoutComments(fs.readFileSync(file, 'utf8'))))) {
    return {
      every: 'the runner config, or a file it is put together from, names projects or a workspace',
    };
  }
  const named = fs
    .readdirSync(dir)
    .filter((name) => READ_BY_NAME.some((pattern) => pattern.test(name)))
    .map((name) => path.join(dir, name));
  const mocks = path.join(dir, '__mocks__');
  const seeds = [
    ...configs.files,
    ...named,
    ...manifest.gates
      .flatMap((gate) => [gate.path, ...gate.existingSpecs])
      .map((file) => path.join(dir, file)),
    ...listed.filter((file) => file.startsWith(`${mocks}${path.sep}`)),
  ]
    .filter((file) => fs.existsSync(file))
    .map(realpath);
  // Files whose text names further files: the configs, those read by name, and what they name.
  const naming = new Set(
    [...configs.files, ...named].filter((file) => fs.existsSync(file)).map(realpath)
  );
  const seen = new Set(seeds);
  const queue = [...seeds];
  const add = (file: string): void => {
    const real = realpath(file);
    if (!seen.has(real)) {
      seen.add(real);
      queue.push(real);
    }
  };
  for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
    if (fs.statSync(file).isDirectory()) {
      continue;
    }
    const edges = fileEdges(file, context);
    if (edges.computed) {
      return { every: edges.unknown ?? 'a file loads modules that are not followed' };
    }
    edges.loads.forEach(add);
    for (const specifier of edges.unnamed) {
      endingAs(specifier, listed).forEach(add);
    }
    // The mock that `jest.mock('./rates')` takes in place of the file.
    const mock = path.join(path.dirname(file), '__mocks__', path.basename(file));
    if (fs.existsSync(mock)) {
      add(mock);
    }
    // What a config names as text: a setup file, an environment, `<rootDir>/test/setup.ts`.
    if (naming.has(file) || (SCRIPT.test(file) && path.dirname(file) === dir)) {
      for (const named of namedIn(file)) {
        const text = named.replace(/^<rootDir>\//, '');
        const here = resolveFiles(path.resolve(path.dirname(file), text), false);
        const found = here.length > 0 ? here : resolveFiles(path.resolve(dir, text), false);
        for (const one of text.includes('*') ? [] : found) {
          // `"extends": "./config/tsconfig.shared.json"` names a file that names others.
          if (!SCRIPT.test(one)) {
            naming.add(realpath(one));
          }
          add(one);
        }
      }
    }
  }
  return { files: seen };
}

/**
 * The files whose path ends as the import after its first part does, both without their
 * extensions (`@shared/fee.js` and `src/fee.ts`). An import of one part (`@helper`, `#config`)
 * leads to the files of that name.
 */
function endingAs(specifier: string, files: string[]): string[] {
  const parts = specifier.split('/');
  const rest = (
    parts.length > 1 ? parts.slice(1).join('/') : specifier.replace(/^[@#~$]+/, '')
  ).replace(/\.[cm]?[jt]sx?$/, '');
  if (rest === '') {
    return [];
  }
  return files.filter((file) => {
    const bare = toPosix(file).replace(/\.[^./]+$/, '');
    return [bare, bare.replace(/\/index$/, '')].some((one) => one.endsWith(`/${rest}`));
  });
}

/**
 * The paths a config names as text. In a script, every string. In data (`tsconfig.json`, a
 * `.babelrc`), only what the tools of a run take from it: what it extends, and the plugins and
 * presets it names. Its `files`, `include` and `exclude` are inputs of the compiler, not of a run.
 */
function namedIn(file: string): string[] {
  const text = fs.readFileSync(file, 'utf8');
  if (SCRIPT.test(file)) {
    return [...text.matchAll(QUOTED)].map((match) => match[2] as string);
  }
  return ['extends', 'plugins', 'presets'].flatMap((key) => valuesOf(text, key));
}

/**
 * The strings of the value of `"key":` in JSON (also with comments, as tsconfig.json has them): a
 * string, or every string in an array that follows it. Read from the text, so that a file JSON
 * cannot parse is read as well.
 */
function valuesOf(text: string, key: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(new RegExp(`"${key}"\\s*:\\s*`, 'g'))) {
    let at = (match.index ?? 0) + match[0].length;
    if (text[at] === '"') {
      const end = text.indexOf('"', at + 1);
      found.push(text.slice(at + 1, end === -1 ? undefined : end));
      continue;
    }
    if (text[at] !== '[') {
      continue;
    }
    // To the bracket that closes the array, past the strings in it.
    let depth = 0;
    for (; at < text.length; at += 1) {
      const char = text[at];
      if (char === '"') {
        const end = text.indexOf('"', at + 1);
        found.push(text.slice(at + 1, end === -1 ? undefined : end));
        at = end === -1 ? text.length : end;
      } else if (char === '[') {
        depth += 1;
      } else if (char === ']') {
        depth -= 1;
        if (depth === 0) {
          break;
        }
      }
    }
  }
  return found;
}

/**
 * The text without its comments. Strings are read past, so that a glob or a URL in
 * one is not taken for the start of a comment; a comment ends a line or at its closing mark.
 */
function withoutComments(text: string): string {
  let out = '';
  for (let at = 0; at < text.length; at += 1) {
    const char = text[at] as string;
    if (char === "'" || char === '"' || char === '`') {
      let end = at + 1;
      while (end < text.length && text[end] !== char && text[end] !== '\n') {
        end += text[end] === '\\' ? 2 : 1;
      }
      out += text.slice(at, end + 1);
      at = end;
    } else if (char === '/' && text[at + 1] === '/') {
      const end = text.indexOf('\n', at);
      at = end === -1 ? text.length : end - 1;
    } else if (char === '/' && text[at + 1] === '*') {
      const end = text.indexOf('*/', at + 2);
      at = end === -1 ? text.length : end + 1;
    } else {
      out += char;
    }
  }
  return out;
}
