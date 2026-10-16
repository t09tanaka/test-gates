import fs from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';
import { isProjectImport } from '../core/import-policy.js';
import { parseImports } from '../core/imports.js';
import type { LoadedFile } from '../core/jobs.js';
import type { LoadedManifest } from '../load.js';

export const SCRIPT = /\.[cm]?[jt]sx?$/;
const EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
export const QUOTED = /(['"`])([^'"`\n]+)\1/g;
// A module that is named to the runner instead of imported: jest.requireActual('fs').
export const RUNNER_LOAD =
  /\b(?:requireActual|requireMock|importActual|importMock|mock|doMock|unstable_mockModule)\(\s*(['"`])([^'"`\n]+)\1/g;

function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** The file a path without (or with a compiled) extension stands for, or null. */
export function resolveFile(base: string, directory = true): string | null {
  const candidates = [
    base,
    ...EXTENSIONS.map((extension) => base + extension),
    // `./fee.js` written in a TypeScript file is `./fee.ts`
    ...EXTENSIONS.map((extension) => base.replace(/\.[cm]?jsx?$/, extension)),
    ...(directory ? EXTENSIONS.map((extension) => path.join(base, `index${extension}`)) : []),
  ];
  return candidates.find(isFile) ?? null;
}

/** Whether `node_modules/<package>` exists in the directory of `from` or above it. */
export function installed(specifier: string, from: string): boolean {
  const name = specifier
    .split('/')
    .slice(0, specifier.startsWith('@') ? 2 : 1)
    .join('/');
  for (let current = path.dirname(from); ; current = path.dirname(current)) {
    if (fs.existsSync(path.join(current, 'node_modules', name))) {
      return true;
    }
    if (current === path.dirname(current)) {
      return false;
    }
  }
}

/**
 * Every file a gate run loads, as far as its text shows: the spec of every gate, the files the
 * gate config names (a setup file, a reporter), and all the project files those import. For
 * `test-gates selfcheck --jobs`, which asks of each of them whether it reaches outside of its
 * process (see src/core/jobs.ts).
 *
 * @param configFile The gate config, relative to the subproject; null when it is not known.
 * @returns `lost`: the first import that leads to no file and to no installed package.
 */
export function loadedFiles(
  manifest: LoadedManifest,
  configFile: string | null
): { files: LoadedFile[]; lost: string | null } {
  const aliases = manifest.settings.importAliases;
  const relative = (file: string) => path.relative(manifest.dir, file).split(path.sep).join('/');
  const target = (specifier: string, from: string): string | null => {
    if (specifier.startsWith('.')) {
      return resolveFile(path.resolve(path.dirname(from), specifier));
    }
    const alias = aliases.find((candidate) => specifier.startsWith(candidate.prefix));
    return alias === undefined
      ? null
      : resolveFile(
          path.resolve(manifest.dir, alias.target + specifier.slice(alias.prefix.length))
        );
  };
  const read = (file: string) => {
    const source = fs.readFileSync(file, 'utf8');
    const imports = parseImports(source).filter((ref) => !ref.typeOnly);
    const specifiers = [
      ...new Set([
        ...imports.map((ref) => ref.module),
        ...[...source.matchAll(RUNNER_LOAD)].map((match) => match[2] as string),
      ]),
    ];
    const strings = [...source.matchAll(QUOTED)]
      .map((match) => match[2] as string)
      .filter((text) => !specifiers.includes(text));
    return { source, specifiers, strings };
  };

  // What the gate config names besides what it imports, in itself and in the project files it
  // is put together from: `setupFiles: ['./test/setup.ts']`, `'<rootDir>/test/setup.js'`.
  const named = new Set<string>();
  const configs = configFile === null ? [] : [path.resolve(manifest.dir, configFile)];
  const seenConfigs = new Set(configs);
  const entry = configs[0];
  for (let file = configs.shift(); file !== undefined; file = configs.shift()) {
    const { specifiers, strings } = read(file);
    // In the gate config itself any text that is the path of a script counts; in the files it
    // imports only one that is written as a path (a comment may name a file).
    const paths = strings.filter((text) => file === entry || /^(?:\.|<rootDir>\/)/.test(text));
    for (const text of paths) {
      const stripped = text.replace(/^<rootDir>\//, '');
      const found =
        resolveFile(path.resolve(path.dirname(file), stripped), false) ??
        resolveFile(path.resolve(manifest.dir, stripped), false);
      if (found !== null && SCRIPT.test(found)) {
        named.add(found);
      }
    }
    for (const specifier of specifiers.filter((one) => isProjectImport(one, aliases))) {
      const found = target(specifier, file);
      if (found !== null && SCRIPT.test(found) && !seenConfigs.has(found)) {
        seenConfigs.add(found);
        configs.push(found);
      }
    }
  }

  const queue = [
    ...manifest.gates.flatMap((gate) =>
      gate.existingSpecs.map((spec) => path.join(manifest.dir, spec))
    ),
    ...named,
  ];
  const seen = new Set(queue);
  const follow = (found: string) => {
    if (SCRIPT.test(found) && !seen.has(found)) {
      seen.add(found);
      queue.push(found);
    }
  };
  const files: LoadedFile[] = [];
  let lost: string | null = null;
  for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
    const { source, specifiers, strings } = read(file);
    const imports: LoadedFile['imports'] = [];
    for (const specifier of specifiers) {
      if (isProjectImport(specifier, aliases)) {
        const found = target(specifier, file);
        if (found === null) {
          lost ??= `${specifier} (imported by ${relative(file)})`;
        } else {
          follow(found);
        }
      } else if (specifier.startsWith('node:') || builtinModules.includes(specifier)) {
        imports.push({ specifier, builtin: true });
      } else if (installed(specifier, file)) {
        imports.push({ specifier, builtin: false });
      } else {
        // not a package: an alias that settings.importAliases does not name
        lost ??= `${specifier} (imported by ${relative(file)})`;
      }
    }
    // A path given to the runner as a string: vi.mock('./rates'), jest.requireActual('./rates').
    for (const text of strings.filter((one) => one.startsWith('.'))) {
      const found = resolveFile(path.resolve(path.dirname(file), text));
      if (found !== null) {
        follow(found);
      }
    }
    files.push({ path: relative(file), source, imports });
  }
  return { files, lost };
}
