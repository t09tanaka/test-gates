import fs from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';
import { isProjectImport } from '../core/import-policy.js';
import { parseImports } from '../core/imports.js';
import type { LoadedFile, LoadRoot } from '../core/jobs.js';
import type { LoadedManifest } from '../load.js';

export const SCRIPT = /\.[cm]?[jt]sx?$/;
/** Components, whose imports (in their scripts, or the frontmatter of Astro) are read as text. */
export const COMPONENT = /\.(?:vue|svelte|astro|mdx)$/;
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

/** What the compiler takes for a module that has no script: `schema.d.ts` for `./schema`. */
const DECLARATIONS = ['.d.ts', '.d.mts', '.d.cts'];

/**
 * The file a path without (or with a compiled) extension stands for, or null.
 *
 * @param directory Whether a directory stands for its index file.
 * @param declarations Whether a declaration file stands for the module when no script does
 *   (`@/types/schema` for `src/types/schema.d.ts`). A script of the same name comes first.
 */
export function resolveFile(base: string, directory = true, declarations = true): string | null {
  const extensions = declarations ? [...EXTENSIONS, ...DECLARATIONS] : EXTENSIONS;
  const candidates = [
    base,
    ...extensions.map((extension) => base + extension),
    // `./fee.js` written in a TypeScript file is `./fee.ts`
    ...extensions.map((extension) => base.replace(/\.[cm]?jsx?$/, extension)),
    ...(directory ? extensions.map((extension) => path.join(base, `index${extension}`)) : []),
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
 * Every file a gate run loads, as far as its text shows, and where each comes from: the spec of
 * every gate, the files the gate config names (a setup file, a reporter; also in the project
 * files the config imports), and all the project files those import. For
 * `test-gates selfcheck --jobs`, which asks of each of them whether it reaches outside of its
 * process, and of each gate which specs load it (see src/core/jobs.ts).
 *
 * @param configFile The gate config, relative to the subproject; null when it is not known.
 * @returns `files`: each file once. `roots`: a root for the spec of every gate, and one for the
 *   files the gate config names, each with every file it loads.
 */
export function loadedFiles(
  manifest: LoadedManifest,
  configFile: string | null
): { files: LoadedFile[]; roots: LoadRoot[] } {
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

  // Each file is read once: what it is, the project files it leads to, and the first of its
  // imports that leads nowhere.
  const known = new Map<string, { file: LoadedFile; next: string[]; lost: string | null }>();
  const visit = (file: string) => {
    const done = known.get(file);
    if (done !== undefined) {
      return done;
    }
    const { source, specifiers, strings } = read(file);
    const imports: LoadedFile['imports'] = [];
    const next: string[] = [];
    // A component can use others that it does not import (registered by a plugin): what it loads
    // is not all in its text.
    let lost: string | null = COMPONENT.test(file)
      ? `${relative(file)} is a component, which can use others that it does not import`
      : null;
    for (const specifier of specifiers) {
      if (isProjectImport(specifier, aliases)) {
        const found = target(specifier, file);
        if (found === null) {
          lost ??= `${specifier} (imported by ${relative(file)})`;
        } else {
          next.push(found);
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
        next.push(found);
      }
    }
    const visited = {
      file: { path: relative(file), source, imports },
      // A component imports like a script (see COMPONENT); data imports nothing.
      next: next.filter((found) => SCRIPT.test(found) || COMPONENT.test(found)),
      lost,
    };
    known.set(file, visited);
    return visited;
  };
  const closure = (spec: string | null, starts: string[]): LoadRoot => {
    const queue = [...starts];
    const seen = new Set(queue);
    const files: string[] = [];
    let lost: string | null = null;
    for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
      const visited = visit(file);
      files.push(visited.file.path);
      lost ??= visited.lost;
      for (const found of visited.next.filter((one) => !seen.has(one))) {
        seen.add(found);
        queue.push(found);
      }
    }
    return { spec, files, lost };
  };

  const specs = [...new Set(manifest.gates.flatMap((gate) => gate.existingSpecs))];
  const roots = [
    closure(null, [...named]),
    ...specs.map((spec) => closure(spec, [path.join(manifest.dir, spec)])),
  ];
  return { files: [...known.values()].map((visited) => visited.file), roots };
}
