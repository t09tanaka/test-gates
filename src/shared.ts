import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The four coverage metrics, all at 100. There is no other threshold. */
export const FULL_COVERAGE = { statements: 100, branches: 100, functions: 100, lines: 100 };

/**
 * `rootDir` of a helper: a directory path, or a `file:` URL of a file inside the directory
 * (`import.meta.url` of the config file). Defaults to the current working directory.
 */
export function resolveRootDir(rootDir: string | undefined): string {
  if (rootDir === undefined) {
    return process.cwd();
  }
  if (rootDir.startsWith('file:')) {
    return path.dirname(fileURLToPath(rootDir));
  }
  return path.resolve(rootDir);
}
