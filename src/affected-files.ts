import fs from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';
import { gateDependencies, kindOf } from './core/affected.js';
import { isProjectImport } from './core/import-policy.js';
import { findUncheckableImports, parseImports } from './core/imports.js';
import { installed, QUOTED, resolveFile, RUNNER_LOAD, SCRIPT } from './commands/loaded-files.js';
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

const toPosix = (file: string): string => file.split(path.sep).join('/');

function realpath(file: string): string {
  try {
    return fs.realpathSync(file);
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

interface Edges {
  /** Project files the file loads. */
  loads: string[];
  /** Why what the file loads cannot be told, or null. */
  unknown: string | null;
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
  const target = (specifier: string, from: string): string | null => {
    if (specifier.startsWith('.')) {
      return resolveFile(path.resolve(path.dirname(from), specifier));
    }
    const alias = aliases.find((candidate) => specifier.startsWith(candidate.prefix));
    return alias === undefined
      ? null
      : resolveFile(path.resolve(dir, alias.target + specifier.slice(alias.prefix.length)));
  };

  const edges = new Map<string, Edges>();
  /** What `file` loads; `strict`: whether a way of loading that the text does not show counts. */
  const edgesOf = (file: string): Edges => {
    const known = edges.get(file);
    if (known !== undefined) {
      return known;
    }
    const found: Edges = { loads: [], unknown: null };
    edges.set(file, found);
    const snapshotFile = path.join(
      path.dirname(file),
      '__snapshots__',
      `${path.basename(file)}.snap`
    );
    if (fs.existsSync(snapshotFile)) {
      found.loads.push(realpath(snapshotFile));
    }
    if (!SCRIPT.test(file)) {
      return found; // data: it loads nothing
    }
    const source = fs.readFileSync(file, 'utf8');
    const uncheckable = findUncheckableImports(source)[0];
    const runtime = RUNTIME_PATHS.exec(source);
    if (uncheckable !== undefined) {
      found.unknown = `${shown(file)}:${uncheckable} imports a module whose path is not written out`;
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
  };
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
