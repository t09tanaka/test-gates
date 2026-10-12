import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { Snapshot } from './core/reuse-guard.js';

/** Thrown when the files a run depends on cannot be listed. The results are then not reused. */
export class SnapshotError extends Error {}

/** Packages whose version changes what a mutation run reports. */
const TOOLS = [
  '@stryker-mutator/core',
  '@stryker-mutator/jest-runner',
  '@stryker-mutator/vitest-runner',
  '@stryker-mutator/typescript-checker',
  'jest',
  'babel-jest',
  'ts-jest',
  '@swc/jest',
  'vitest',
  'vite',
  '@vitest/coverage-istanbul',
  '@vitest/coverage-v8',
  'typescript',
];

/** Files a package manager writes into node_modules when it installs. */
const INSTALL_MARKERS = ['.package-lock.json', '.yarn-integrity', '.modules.yaml'];

/** Directories that are never part of a snapshot. */
const NEVER = ['node_modules', '.git'];

/** Files in which a path to another directory may be written. */
const SCANNED = /\.(?:[cm]?[jt]sx?|json|vue)$/;
const SCAN_LIMIT = 2 * 1024 * 1024;
/** A string literal with `..` as a part of a path: it may lead out of the directory of its file. */
const UPWARD = /(['"`])((?:[^'"`\n]*\/)?\.\.(?:\/[^'"`\n]*)?)\1/g;

function hashOf(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex');
}

/** Hash of a file, or null when there is no such file. */
export function hashFile(file: string): string | null {
  try {
    return hashOf(fs.readFileSync(file));
  } catch {
    return null;
  }
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function toPosix(file: string): string {
  return file.split(path.sep).join('/');
}

function git(cwd: string, args: string[]): string | null {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024 });
  return result.error || result.status !== 0 ? null : result.stdout;
}

/** Lists the files below a directory, relative to `root`. */
type Lister = (directory: string, recursive: boolean) => string[];

function gitLister(root: string): Lister {
  return (directory, recursive) => {
    const relative = toPosix(path.relative(root, directory));
    const pattern = recursive
      ? `${relative === '' ? '' : `${relative}/`}**`
      : `${relative === '' ? '' : `${relative}/`}*`;
    const listed = git(root, [
      'ls-files',
      '-z',
      '--cached',
      '--others',
      '--exclude-standard',
      '--',
      `:(glob)${pattern}`,
    ]);
    if (listed === null) {
      throw new SnapshotError('git could not list the files');
    }
    return listed.split('\0').filter((file) => file !== '');
  };
}

function walkLister(root: string): Lister {
  const walk = (directory: string, recursive: boolean, found: string[]): string[] => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (recursive && !NEVER.includes(entry.name)) {
          walk(file, true, found);
        }
      } else {
        found.push(toPosix(path.relative(root, file)));
      }
    }
    return found;
  };
  return (directory, recursive) => walk(directory, recursive, []);
}

/** What is stored for one path: the content of a file, the target of a link. */
function fingerprint(file: string): string {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch {
    return 'missing';
  }
  if (stat.isSymbolicLink()) {
    return `link ${fs.readlinkSync(file)}`;
  }
  if (stat.isDirectory()) {
    // A submodule: git lists it as one path.
    return `directory ${git(file, ['rev-parse', 'HEAD'])?.trim() ?? ''}`;
  }
  return hashOf(fs.readFileSync(file));
}

/** Directories from `from` up to `to`, both included. `to` contains `from`. */
function upTo(from: string, to: string): string[] {
  const directories = [from];
  while (directories[directories.length - 1] !== to) {
    directories.push(path.dirname(directories[directories.length - 1] as string));
  }
  return directories;
}

/** Packages of the same repository that are linked into a node_modules directory. */
function linkedPackages(nodeModules: string, root: string): string[] {
  const found: string[] = [];
  const visit = (directory: string, depth: number): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        let target: string;
        try {
          target = fs.realpathSync(file);
        } catch {
          continue;
        }
        if (
          isInside(root, target) &&
          !path.relative(root, target).split(path.sep).includes('node_modules') &&
          fs.statSync(target).isDirectory()
        ) {
          found.push(target);
        }
      } else if (depth === 0 && entry.isDirectory() && entry.name.startsWith('@')) {
        visit(file, 1);
      }
    }
  };
  visit(nodeModules, 0);
  return found;
}

/** Version of an installed package, looked up from `start` upwards. */
function installedVersion(start: string, name: string): string | null {
  let current = start;
  for (;;) {
    try {
      const manifest = JSON.parse(
        fs.readFileSync(path.join(current, 'node_modules', name, 'package.json'), 'utf8')
      ) as { version?: unknown };
      return typeof manifest.version === 'string' ? manifest.version : 'unknown';
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        return null;
      }
      current = parent;
    }
  }
}

function ownVersion(): string {
  const { version } = createRequire(import.meta.url)('../package.json') as { version: string };
  return version;
}

/**
 * Takes the snapshot of everything a mutation run of the subproject depends on, apart from the
 * gates and their specs (Stryker compares those itself).
 *
 * The files are those of the subproject, the files directly in the directories above it (lock
 * files, shared configs), packages of the same repository linked into node_modules, and every
 * directory outside the subproject that a file points at with a path starting with `..`. With
 * git, files that are ignored are left out; without it, everything but node_modules is read.
 *
 * @param input.dir Absolute path of the subproject.
 * @param input.own Paths relative to `dir` that Stryker compares itself: gates and specs.
 * @param input.written Absolute paths the run writes (reports, the sandbox), as files or
 *   directories.
 * @throws SnapshotError when the files cannot be listed, or a path leads out of what can be
 *   listed.
 */
export function takeSnapshot(input: {
  dir: string;
  own: string[];
  written: string[];
  args: string[];
}): Snapshot {
  const dir = fs.realpathSync(input.dir);
  const top = git(dir, ['rev-parse', '--show-toplevel']);
  let root = top === null ? dir : fs.realpathSync(top.trim());
  let lister = gitLister(root);
  let mode: Snapshot['mode'] = 'git';
  const manifest = toPosix(path.relative(root, path.join(dir, 'test-gates.json')));
  if (top === null || !lister(dir, false).includes(manifest)) {
    // No git, or the subproject is not something git lists: read the directories.
    mode = 'walk';
    root = dir;
    for (const directory of upTo(dir, path.parse(dir).root)) {
      if (fs.existsSync(path.join(directory, 'package.json'))) {
        root = directory;
      }
    }
    lister = walkLister(root);
  }

  const listRoot = root;
  const list = lister;
  const own = new Set(input.own.map((file) => path.join(dir, file)));
  const written = input.written.map((file) => path.resolve(dir, file));
  const files: Record<string, string> = {};
  const add = (relative: string): string | null => {
    const file = path.join(listRoot, relative);
    if (own.has(file) || written.some((target) => isInside(target, file))) {
      return null;
    }
    if (!(relative in files)) {
      files[relative] = fingerprint(file);
    }
    return file;
  };

  const ancestors = upTo(dir, listRoot).slice(1);
  for (const directory of ancestors) {
    list(directory, false).forEach(add);
  }

  // The subproject, then every directory its files (and the files of those directories) lead to.
  const regions = [dir];
  const queued = new Set(regions);
  const enqueue = (directory: string, from: string): void => {
    if (!isInside(listRoot, directory)) {
      throw new SnapshotError(
        `${toPosix(path.relative(dir, from))} points outside of what can be listed (${directory})`
      );
    }
    if (![...queued].some((region) => isInside(region, directory))) {
      queued.add(directory);
      regions.push(directory);
    }
  };
  for (const directory of [dir, ...ancestors]) {
    for (const linked of linkedPackages(path.join(directory, 'node_modules'), listRoot)) {
      if (!isInside(linked, dir)) {
        enqueue(linked, path.join(directory, 'node_modules'));
      }
    }
    for (const marker of INSTALL_MARKERS) {
      const file = path.join(directory, 'node_modules', marker);
      const hash = hashFile(file);
      if (hash !== null) {
        files[toPosix(path.relative(listRoot, file))] = hash;
      }
    }
  }
  for (let position = 0; position < regions.length; position += 1) {
    const region = regions[position] as string;
    for (const relative of list(region, true)) {
      add(relative);
      const file = path.join(listRoot, relative);
      if (!SCANNED.test(relative)) {
        continue;
      }
      let text: string;
      try {
        if (fs.statSync(file).size > SCAN_LIMIT) {
          continue;
        }
        text = fs.readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      for (const match of text.matchAll(UPWARD)) {
        const literal = match[2] as string;
        if (!literal.startsWith('..')) {
          // `<rootDir>/../shared`, `${here}/..`: where it starts is not known. Take everything.
          enqueue(listRoot, file);
          continue;
        }
        const target = path.resolve(path.dirname(file), literal);
        let isDirectory = false;
        try {
          isDirectory = fs.statSync(target).isDirectory();
        } catch {
          // An import without its extension, or a file that is not there: take its directory.
        }
        const directory = isDirectory ? target : path.dirname(target);
        // A file directly in a directory above the subproject is in the snapshot already.
        if (!isDirectory && ancestors.includes(directory)) {
          continue;
        }
        // Nothing is there (text that only looks like a path). Should the directory appear later,
        // it is looked at then.
        if (!fs.existsSync(directory)) {
          continue;
        }
        // A directory that contains the subproject: what is used of it cannot be told. Take
        // everything that can be listed; outside of that, enqueue refuses.
        enqueue(
          isInside(directory, dir) && isInside(listRoot, directory) ? listRoot : directory,
          file
        );
      }
    }
  }

  const environment: Record<string, string> = {
    'Node.js': process.version,
    platform: `${process.platform} ${process.arch}`,
    'test-gates': ownVersion(),
  };
  for (const name of TOOLS) {
    const version = installedVersion(dir, name);
    if (version !== null) {
      environment[name] = version;
    }
  }

  return {
    mode,
    environment,
    args: input.args,
    files,
  };
}
