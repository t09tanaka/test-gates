import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { gitEnvironment } from './snapshot.js';

/** A directory in a linked worktree, and the main worktree of the same repository. */
export interface LinkedWorktree {
  /** The top of the linked worktree the directory is in. */
  top: string;
  /** The top of the main worktree. */
  main: string;
}

function git(dir: string, args: string[]): string[] | null {
  const result = spawnSync('git', args, {
    cwd: dir,
    env: gitEnvironment(process.env),
    encoding: 'utf8',
  });
  return result.error || result.status !== 0 ? null : result.stdout.trim().split('\n');
}

/**
 * The main worktree, when `dir` is in a linked worktree (one made by `git worktree add`); null
 * in the main worktree, outside of git, or in a repository without a main worktree (a bare one).
 */
export function linkedWorktreeOf(dir: string): LinkedWorktree | null {
  const found = git(dir, [
    'rev-parse',
    '--path-format=absolute',
    '--show-toplevel',
    '--git-dir',
    '--git-common-dir',
  ]);
  if (found === null || found.length !== 3) {
    return null;
  }
  const [top, gitDir, common] = found as [string, string, string];
  // A linked worktree has a git directory of its own below the common one. The main worktree
  // is the directory that holds the common one; a bare repository has none.
  if (gitDir === common || path.basename(common) !== '.git') {
    return null;
  }
  try {
    const main = fs.realpathSync(path.dirname(common));
    const real = fs.realpathSync(top);
    return main === real ? null : { top: real, main };
  } catch {
    return null;
  }
}

/**
 * Where the main worktree keeps the same files: the same path relative to the top of the
 * worktree. Null for a file outside the linked worktree.
 */
export function inMainWorktree(linked: LinkedWorktree, file: string): string | null {
  const relative = path.relative(linked.top, file);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    return null;
  }
  return path.join(linked.main, relative);
}
