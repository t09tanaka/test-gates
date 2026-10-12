import fs from 'node:fs';
import path from 'node:path';

/**
 * The names in directories that were already read, by the path of the directory; null for one
 * that cannot be read. For a caller that asks about many paths in a row: the gates of a project
 * mostly share their directories, and each would otherwise be read again for every path. Not to
 * be kept beyond that: a file created later is not in it.
 */
export type Listing = Map<string, string[] | null>;

/**
 * True when `relativePath` is a file (or, with `kind: 'any'`, a file or directory) under
 * `rootDir` with exactly this spelling.
 * The default macOS and Windows file systems treat `Basket.spec.ts` and `basket.spec.ts` as the
 * same file; Linux (CI) does not. Each segment is therefore compared with the directory listing.
 *
 * @param listing Directories read by earlier calls, and filled by this one. Without it every
 *   directory on the way is read anew.
 */
export function existsExact(
  rootDir: string,
  relativePath: string,
  kind: 'file' | 'any' = 'file',
  listing: Listing = new Map()
): boolean {
  let current = rootDir;
  for (const segment of relativePath.split('/')) {
    if (segment === '' || segment === '.') {
      continue;
    }
    let entries = listing.get(current);
    if (entries === undefined) {
      try {
        entries = fs.readdirSync(current);
      } catch {
        entries = null;
      }
      listing.set(current, entries);
    }
    if (entries === null || !entries.includes(segment)) {
      return false;
    }
    current = path.join(current, segment);
  }
  try {
    return kind === 'any' || fs.statSync(current).isFile();
  } catch {
    return false;
  }
}

export function readText(rootDir: string, relativePath: string): string {
  return fs.readFileSync(path.join(rootDir, relativePath), 'utf8');
}

/** `node_modules/.bin/<name>` of `startDir` or the nearest ancestor that has it. */
export function findLocalBin(startDir: string, name: string): string | null {
  const file = process.platform === 'win32' ? `${name}.cmd` : name;
  let current = path.resolve(startDir);
  for (;;) {
    const candidate = path.join(current, 'node_modules', '.bin', file);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}
