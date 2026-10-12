import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { repoRoot } from '../helpers';

// A real Stryker run. Stryker 10 does not start below Node.js 22.12.
const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
export const strykerRuns = major > 22 || (major === 22 && minor >= 12);

export const helper = (name: string) =>
  pathToFileURL(path.join(repoRoot, 'dist', `${name}.js`)).href;
export const gate = (file: string) => ({ path: file, decides: 'd', impact: 'i' });
export const SPEC_HEAD = "import { expect, it } from 'vitest';\nimport { has } from './kinds';\n";
export const KNOWS_A =
  "it('knows a', () => { expect(has('a')).toBe(true); expect(has('z')).toBe(false); });\n";
export const KNOWS_B =
  "it('knows b', () => { expect(has('b')).toBe(true); expect(has('')).toBe(false); });\n";

export function report(dir: string, file: string): Record<string, { status: string }[]> {
  const parsed = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) as {
    files: Record<string, { mutants: { status: string }[] }>;
  };
  return Object.fromEntries(
    Object.entries(parsed.files).map(([name, value]) => [name, value.mutants])
  );
}
