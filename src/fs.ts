import fs from 'node:fs';
import path from 'node:path';

/**
 * True when `relativePath` is a file (or, with `kind: 'any'`, a file or directory) under
 * `rootDir` with exactly this spelling.
 * The default macOS and Windows file systems treat `Plan.spec.ts` and `plan.spec.ts` as the
 * same file; Linux (CI) does not. Each segment is therefore compared with the directory listing.
 */
export function existsExact(
  rootDir: string,
  relativePath: string,
  kind: 'file' | 'any' = 'file'
): boolean {
  let current = rootDir;
  for (const segment of relativePath.split('/')) {
    if (segment === '' || segment === '.') {
      continue;
    }
    let entries: string[];
    try {
      entries = fs.readdirSync(current);
    } catch {
      return false;
    }
    if (!entries.includes(segment)) {
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
