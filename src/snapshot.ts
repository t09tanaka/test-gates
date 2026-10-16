import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
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
const INSTALL_MARKERS = [
  '.package-lock.json',
  '.yarn-integrity',
  '.yarn-state.yml',
  '.modules.yaml',
];

const LOCK_FILES = [
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lock',
  'bun.lockb',
];

/** Directories that are never part of a snapshot. */
const NEVER = ['node_modules', '.git'];

/** Larger files are hashed but not searched for paths. */
const SCAN_LIMIT = 8 * 1024 * 1024;
/** A string literal with `..` as a part of a path: it may lead out of the directory of its file. */
const UPWARD = /(['"`])((?:[^'"`\n]*\/)?\.\.(?:\/[^'"`\n]*)?)\1/g;
/** Files written for people to read: hashed, but the paths in them are not followed. */
const DOCUMENTS = ['.md', '.markdown', '.txt', '.rst', '.adoc'];
/** The start of a template literal that is the directory of its own file. */
const HERE = /^\$\{(?:__dirname|import\.meta\.dirname)\}(?=\/)/;
/**
 * The directory of the file, then string literals as further arguments (`__dirname, '..', 'x'`
 * handed to path.join or path.resolve). Group 1 holds the literals; group 3 the closing
 * parenthesis, when nothing but those literals follows.
 */
const FROM_HERE = /\b(?:__dirname|import\.meta\.dirname)((?:\s*,\s*(['"])[^'"`\n]*\2)+)(\s*\))?/g;
const LITERAL = /(['"])([^'"`\n]*)\1/g;
const isUpward = (segment: string): boolean => segment.split('/').includes('..');

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

/**
 * The environment for git. A hook of a linked worktree runs with `GIT_DIR` set and without
 * `GIT_WORK_TREE`: git then takes the directory it is called in for the top of the work tree,
 * and a subproject looks like the whole repository. Without `GIT_WORK_TREE` the variable is left
 * out, so that git finds the repository from the directory, as it does outside of a hook.
 */
export function gitEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (env.GIT_DIR === undefined || env.GIT_WORK_TREE !== undefined) {
    return env;
  }
  const rest = { ...env };
  delete rest.GIT_DIR;
  return rest;
}

function git(cwd: string, args: string[]): string | null {
  const result = spawnSync('git', args, {
    cwd,
    env: gitEnvironment(process.env),
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 1024,
  });
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
      if (NEVER.includes(entry.name)) {
        continue; // also when it is a link to a directory of that name
      }
      if (entry.isDirectory()) {
        if (recursive) {
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

/** Directories from `from` up to `to`, both included. `to` contains `from`. */
function upTo(from: string, to: string): string[] {
  const directories = [from];
  while (directories[directories.length - 1] !== to) {
    directories.push(path.dirname(directories[directories.length - 1] as string));
  }
  return directories;
}

function declaresWorkspaces(directory: string): boolean {
  if (fs.existsSync(path.join(directory, 'pnpm-workspace.yaml'))) {
    return true;
  }
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8')) as {
      workspaces?: unknown;
    };
    return manifest.workspaces !== undefined;
  } catch {
    return false;
  }
}

/**
 * How far up the directories are read without git: to the nearest directory with a `.git`
 * entry, else to the topmost one that declares workspaces, else no further than the subproject.
 * Never the home directory or anything above it: what lies there is not part of a project.
 */
function walkRoot(dir: string): string {
  const candidates = withinBounds(dir);
  const repository = candidates.find((directory) => fs.existsSync(path.join(directory, '.git')));
  if (repository !== undefined) {
    return repository;
  }
  return candidates.filter(declaresWorkspaces).pop() ?? dir;
}

/** `dir` and the directories above it, without the home directory and what lies above that. */
function withinBounds(dir: string): string[] {
  let home: string | null = null;
  try {
    home = fs.realpathSync(os.homedir());
  } catch {
    // no home directory: only the root of the file system is out of bounds
  }
  return upTo(dir, path.parse(dir).root).filter(
    (directory) =>
      directory !== path.parse(dir).root && (home === null || !isInside(directory, home))
  );
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
        if (target.split(path.sep).includes('node_modules') || !fs.statSync(target).isDirectory()) {
          continue; // the layout of a package manager, not a package of the repository
        }
        if (!isInside(root, target)) {
          throw new SnapshotError(
            `${file} is a link to a directory outside of what can be listed (${target})`
          );
        }
        found.push(target);
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
 * Takes the snapshot of everything a mutation run of the subproject depends on.
 *
 * The files are those of the subproject, the files directly in the directories above it (lock
 * files, shared configs), packages of the same repository linked into node_modules, and every
 * directory outside the subproject that a file points at: with a link, or with a path that has
 * `..` in it (also one that starts at `__dirname`). Where such a path cannot be followed, every
 * file that can be listed is taken. Paths in files written for people are not followed.
 * With git, files that are ignored are left out; without it, everything but node_modules is
 * read.
 *
 * @param input.dir Absolute path of the subproject.
 * @param input.written Paths the run writes (reports, the sandbox), as files or directories,
 *   absolute or relative to `dir`.
 * @throws SnapshotError when the files cannot be listed, or a path leads out of what can be
 *   listed.
 */
export function takeSnapshot(input: { dir: string; written: string[]; args: string[] }): Snapshot {
  return snapshotOf(input).snapshot;
}

/**
 * The snapshot (see takeSnapshot), and the directory its keys are relative to.
 *
 * @throws SnapshotError as takeSnapshot does.
 */
export function snapshotOf(input: { dir: string; written: string[]; args: string[] }): {
  snapshot: Snapshot;
  root: string;
} {
  const dir = fs.realpathSync(input.dir);
  const top = git(dir, ['rev-parse', '--show-toplevel']);
  let root = top === null ? dir : fs.realpathSync(top.trim());
  let lister = gitLister(root);
  let mode: Snapshot['mode'] = 'git';
  const manifest = toPosix(path.relative(root, path.join(dir, 'test-gates.json')));
  if (top === null || !lister(dir, false).includes(manifest)) {
    // No git, or the subproject is not something git lists: read the directories.
    mode = 'walk';
    root = walkRoot(dir);
    lister = walkLister(root);
  }

  const listRoot = root;
  const list = lister;
  const walk = walkLister(listRoot);
  const written = input.written.map((file) => {
    const target = path.resolve(dir, file);
    try {
      return fs.realpathSync(target);
    } catch {
      return target;
    }
  });
  const swallowing = written.find((target) => isInside(target, path.join(dir, 'test-gates.json')));
  if (swallowing !== undefined) {
    throw new SnapshotError(`the run writes to ${swallowing}, which holds test-gates.json`);
  }
  // No prototype: a file may be called "constructor".
  const files = Object.create(null) as Record<string, string>;

  // The subproject, then every directory its files (and the files of those directories) lead to.
  const regions = [dir];
  const queued = new Set(regions);
  /**
   * @param reference The path as it is written in `from`, for the message.
   * @param anchored Whether `target` is the whole path, counted from the directory of `from`
   *   (`join(__dirname, '..')`). Such a path to a directory above the subproject leads to the
   *   files directly in it, and those are compared anyway.
   */
  const enqueue = (target: string, from: string, reference?: string, anchored = false): void => {
    // The subproject itself is not above it: a path to it adds nothing.
    const above = target !== dir && isInside(target, dir) && isInside(listRoot, target);
    if (above && anchored) {
      return;
    }
    // Of a directory that contains the subproject, what is used cannot be told: take everything.
    const directory = above ? listRoot : target;
    if (!isInside(listRoot, directory)) {
      const written = reference === undefined ? '' : ` with ${JSON.stringify(reference)}`;
      throw new SnapshotError(
        `${toPosix(path.relative(dir, from))} points outside of what can be listed${written} (${directory})`
      );
    }
    if (![...queued].some((region) => isInside(region, directory))) {
      queued.add(directory);
      regions.push(directory);
    }
  };
  /**
   * A path found in `file`: the directory it leads to joins the snapshot.
   *
   * @param fixed The known part of the path, relative to the directory of `file`.
   * @param open Whether something unknown follows it (a placeholder, a variable).
   * @param anchored Whether the path is written as one from the directory of the file
   *   (`__dirname`), rather than as a plain relative path.
   * @param reference The path as written in `file`, for the message.
   */
  const follow = (
    fixed: string,
    open: boolean,
    anchored: boolean,
    file: string,
    reference: string
  ): void => {
    const target = path.resolve(path.dirname(file), fixed);
    let isDirectory = false;
    try {
      isDirectory = fs.statSync(target).isDirectory();
    } catch {
      // An import without its extension, or a file that is not there: take its directory.
    }
    const directory = isDirectory ? target : path.dirname(target);
    // Nothing is there (text that only looks like a path). Should the directory appear later, it
    // is looked at then.
    if (fs.existsSync(directory)) {
      enqueue(directory, file, reference, anchored && !open);
    }
  };
  /** Follows every path in the text of `file` that has `..` in it. */
  const scan = (text: string, file: string): void => {
    // `__dirname, '..', 'x'`: the literals are one path. Their places are kept so that the
    // search below does not take each `'..'` for a path of its own.
    const taken: Array<[number, number]> = [];
    for (const match of text.matchAll(FROM_HERE)) {
      const literals = match[1] as string;
      const segments = [...literals.matchAll(LITERAL)].map((literal) => literal[2] as string);
      if (!segments.some(isUpward)) {
        continue;
      }
      const start = (match.index ?? 0) + match[0].indexOf(literals);
      taken.push([start, start + literals.length]);
      // Anything but the closing parenthesis after them, or something added to what the call
      // returns (`join(join(__dirname, '..'), name)`, `` `${join(__dirname, '..')}/x` ``,
      // `+ '/x'`): the end of the path is not known.
      const end = (match.index ?? 0) + match[0].length;
      const open = match[3] === undefined || /^\s*[,+.}[]/.test(text.slice(end, end + 200));
      const reference = match[0].slice(0, match[0].length - (match[3]?.length ?? 0));
      follow(path.posix.join(...segments), open, true, file, reference);
    }
    for (const match of text.matchAll(UPWARD)) {
      const at = match.index ?? 0;
      if (taken.some(([start, end]) => at >= start && at < end)) {
        continue;
      }
      const literal = match[2] as string;
      // `${__dirname}/../shared` starts in the directory of the file.
      const here = HERE.exec(literal);
      const relative = here === null ? literal : `.${literal.slice(here[0].length)}`;
      // `../fixtures/${name}.json`: what is known is the part before the placeholder.
      const open = relative.includes('${');
      const fixed = open
        ? relative.slice(0, relative.lastIndexOf('/', relative.indexOf('${')) + 1)
        : relative;
      if (
        (here === null && !fixed.startsWith('../')) ||
        (open && isUpward(relative.slice(relative.indexOf('${'))))
      ) {
        // `<rootDir>/../shared`, a lone `..` handed to path.join, or a way up after a
        // placeholder (`${__dirname}/${name}/../..`): where it leads is not known.
        enqueue(listRoot, file);
      } else {
        follow(fixed, open, here !== null, file, literal);
      }
    }
  };
  const add = (relative: string): void => {
    const file = path.join(listRoot, relative);
    if (relative in files || written.some((target) => isInside(target, file))) {
      return;
    }
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(file);
    } catch {
      files[relative] = 'missing';
      return;
    }
    if (stat.isSymbolicLink()) {
      files[relative] = `link ${fs.readlinkSync(file)}`;
      let target: string;
      try {
        target = fs.realpathSync(file);
      } catch {
        return; // a link to nothing
      }
      enqueue(fs.statSync(target).isDirectory() ? target : path.dirname(target), file);
    } else if (stat.isDirectory()) {
      // A repository inside the repository: git lists it as one path. Read what is in it.
      files[relative] = 'directory';
      walk(file, true).forEach(add);
    } else if (!stat.isFile()) {
      files[relative] = 'special';
    } else {
      const content = fs.readFileSync(file);
      files[relative] = hashOf(content);
      const document = DOCUMENTS.includes(path.extname(file).toLowerCase());
      if (!document && content.length <= SCAN_LIMIT && !content.subarray(0, 8000).includes(0)) {
        // `..\/` in JSON and `..\\` on Windows are the same path.
        scan(content.toString('utf8').replace(/\\[\\/]/g, '/'), file);
      }
    }
  };

  const ancestors = upTo(dir, listRoot).slice(1);
  for (const directory of ancestors) {
    list(directory, false).forEach(add);
  }
  for (const directory of [dir, ...ancestors]) {
    for (const linked of linkedPackages(path.join(directory, 'node_modules'), listRoot)) {
      if (!isInside(linked, dir)) {
        enqueue(linked, path.join(directory, 'node_modules'));
      }
    }
  }
  // What is installed, and the lock files: also above what is listed, where the node_modules
  // of a workspace may be. By name only; nothing else up there is read.
  const above = withinBounds(listRoot).slice(1);
  for (const directory of [dir, ...ancestors, ...above]) {
    const candidates = [
      ...INSTALL_MARKERS.map((marker) => path.join(directory, 'node_modules', marker)),
      ...(above.includes(directory) ? LOCK_FILES.map((name) => path.join(directory, name)) : []),
    ];
    for (const file of candidates) {
      const hash = hashFile(file);
      if (hash !== null) {
        files[toPosix(path.relative(listRoot, file))] = hash;
      }
    }
  }
  for (let position = 0; position < regions.length; position += 1) {
    list(regions[position] as string, true).forEach(add);
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

  return { snapshot: { mode, environment, args: input.args, files }, root: listRoot };
}
