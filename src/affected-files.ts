import fs from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';
import { gateDependencies, kindOf } from './core/affected.js';
import { isProjectImport } from './core/import-policy.js';
import { findUncheckableImports, parseImports } from './core/imports.js';
import { installed, QUOTED, resolveFile, RUNNER_LOAD, SCRIPT } from './commands/loaded-files.js';
import type { ImportAlias } from './core/types.js';
import type { LoadedManifest } from './load.js';

/** Thrown when what a gate depends on cannot be told from the text of the files. */
export class AffectedError extends Error {}

/**
 * What lets a file read other files, or load modules, in a way that its imports do not show.
 * Where one of them is used, a change to a file that nothing imports could change a result.
 */
const RUNTIME_PATHS =
  /\b(?:__dirname|__filename|require\.(?:context|resolve)|process\.cwd|createRequire|toMatchFileSnapshot|readFileSync|readdirSync)\b|\bimport\.meta\.(?:url|dirname|filename|glob|resolve)\b/;
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
/** Components, whose imports are read like those of a script. */
const COMPONENT = /\.(?:vue|svelte|astro|mdx)$/;

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
}

/** Where the config of the test runner is, from the options the Stryker config gives it. */
export function runnerConfigs(
  dir: string,
  stryker: string,
  options: { testRunner?: unknown; vitestConfig?: unknown; jestConfig?: unknown }
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
  return { files: files.filter((file) => fs.existsSync(file)).map(realpath) };
}

export interface Edges {
  /** Project files the file loads. */
  loads: string[];
  /** Why what the file loads cannot be told, or null. */
  unknown: string | null;
  /** Whether the file loads modules that are not followed: a path not written out, a component, a linked package. */
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
  context: { dir: string; aliases: ImportAlias[]; cache: Map<string, Edges> }
): Edges {
  const { dir, aliases, cache } = context;
  const known = cache.get(file);
  if (known !== undefined) {
    return known;
  }
  const shown = (one: string): string => toPosix(path.relative(dir, one));
  const target = (specifier: string, from: string): string | null => {
    if (specifier.startsWith('.')) {
      return resolveFile(path.resolve(path.dirname(from), specifier));
    }
    const alias = aliases.find((candidate) => specifier.startsWith(candidate.prefix));
    return alias === undefined
      ? null
      : resolveFile(path.resolve(dir, alias.target + specifier.slice(alias.prefix.length)));
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
  // A component imports in its scripts (or the frontmatter of Astro): read as one text.
  const source = fs.readFileSync(file, 'utf8');
  const uncheckable = findUncheckableImports(source)[0];
  const runtime = RUNTIME_PATHS.exec(source);
  if (uncheckable !== undefined) {
    found.unknown = `${shown(file)}:${uncheckable} imports a module whose path is not written out`;
    found.computed = true;
  } else if (runtime !== null) {
    found.unknown = `${shown(file)} uses ${runtime[0]}, which can reach files that no import names`;
  }
  const specifiers = new Set([
    ...parseImports(source).map((ref) => ref.module),
    ...[...source.matchAll(RUNNER_LOAD)].map((match) => match[2] as string),
  ]);
  for (const specifier of specifiers) {
    if (path.isAbsolute(specifier) || specifier.startsWith('file:')) {
      const resolved = resolveFile(
        specifier.startsWith('file:') ? new URL(specifier).pathname : specifier
      );
      if (resolved === null) {
        found.unknown ??= `${shown(file)} imports ${specifier}, which leads to no file`;
      } else {
        found.loads.push(realpath(resolved));
      }
    } else if (isProjectImport(specifier, aliases)) {
      const resolved = target(specifier, file);
      if (resolved === null) {
        found.unknown ??= `${shown(file)} imports ${specifier}, which leads to no file`;
      } else {
        found.loads.push(realpath(resolved));
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
  // A path given to the runner as text: vi.mock('./rates', …).
  for (const match of source.matchAll(QUOTED)) {
    const text = match[2] as string;
    if (text.startsWith('.') && !specifiers.has(text)) {
      const resolved = resolveFile(path.resolve(path.dirname(file), text));
      if (resolved !== null) {
        found.loads.push(realpath(resolved));
      }
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
  const edges = new Map<string, Edges>();
  const edgesOf = (file: string): Edges => fileEdges(file, { dir, aliases, cache: edges });
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
        const found =
          resolveFile(path.resolve(path.dirname(loaded), text), false) ??
          resolveFile(path.resolve(dir, text), false);
        if (found !== null && !text.includes('*') && isCompared(found)) {
          named.push(realpath(found));
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
  const escaped = [...names].map((name) => name.replace(/\$/g, '\\$'));
  const call = `(?:defineConfig\\s*\\(\\s*)?(?:${escaped.join('|')})\\s*\\(`;
  const exported = '(?:export\\s+default|module\\.exports\\s*=)\\s*';
  if (new RegExp(`${exported}${call}`).test(text)) {
    return true;
  }
  const variable = new RegExp(`\\b(?:const|let|var)\\s+([\\w$]+)\\s*=\\s*${call}`).exec(text);
  return (
    variable !== null &&
    new RegExp(`${exported}${(variable[1] as string).replace(/\$/g, '\\$')}\\s*(?:;|$)`, 'm').test(
      text
    ) &&
    !new RegExp(`\\b${(variable[1] as string).replace(/\$/g, '\\$')}\\s*(?:\\.|\\[)`).test(text)
  );
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
 * @returns null when the specs the run starts are not known, or when a file loads a module whose
 *   path is not written out: then every file is followed.
 */
export function loadedScope(
  manifest: LoadedManifest,
  configs: RunConfigs,
  listed: string[]
): Set<string> | null {
  const dir = realpath(manifest.dir);
  const cache = new Map<string, Edges>();
  const context = { dir, aliases: manifest.settings.importAliases, cache };
  // Only a config that is what a helper of this tool returns runs the specs of the gates and no
  // others: the helper sets them after the options it is given. Not one that changes what the
  // helper returns (merged with another config, spread with more after it), and not one given
  // projects of its own, which the helper passes on, also from a file it is put together from.
  const runner = configs.files.slice(1);
  const texts = runner.map((file) => withoutComments(fs.readFileSync(file, 'utf8')));
  if (runner.length === 0 || !texts.every((text) => OWN.test(text) && isHelperResult(text))) {
    return null;
  }
  const parts = new Set(runner.map(realpath));
  for (const file of [...parts]) {
    if (SCRIPT.test(file)) {
      fileEdges(file, context).loads.forEach((loaded) => parts.add(loaded));
    }
  }
  if ([...parts].some((file) => PROJECTS.test(withoutComments(fs.readFileSync(file, 'utf8'))))) {
    return null;
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
      return null;
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
        const found =
          resolveFile(path.resolve(path.dirname(file), text), false) ??
          resolveFile(path.resolve(dir, text), false);
        if (found !== null && !text.includes('*')) {
          // `"extends": "./config/tsconfig.shared.json"` names a file that names others.
          if (!SCRIPT.test(found)) {
            naming.add(realpath(found));
          }
          add(found);
        }
      }
    }
  }
  return seen;
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
