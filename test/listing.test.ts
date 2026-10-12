import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { checkGates } from '../src/commands/check';
import { existsExact, type Listing } from '../src/fs';
import { readManifest } from '../src/load';
import { cleanup, project } from './helpers';

afterAll(cleanup);
afterEach(() => vi.restoreAllMocks());

const read = () => vi.spyOn(fs, 'readdirSync');
const readOf = (spy: ReturnType<typeof read>, dir: string) =>
  spy.mock.calls.map(([directory]) => path.relative(dir, String(directory))).sort();

describe('existsExact with a listing', () => {
  const files = () =>
    project({ 'src/pricing/fee.ts': '', 'src/pricing/tax.ts': '', 'src/age.ts': '' });

  it('reads every directory once for all the paths that are asked about', () => {
    const dir = files();
    const spy = read();
    const listing: Listing = new Map();
    expect(existsExact(dir, 'src/pricing/fee.ts', 'file', listing)).toBe(true);
    expect(existsExact(dir, 'src/pricing/tax.ts', 'file', listing)).toBe(true);
    expect(existsExact(dir, 'src/pricing/Tax.ts', 'file', listing)).toBe(false);
    expect(existsExact(dir, 'src/pricing/gone.ts', 'file', listing)).toBe(false);
    expect(existsExact(dir, 'src/age.ts', 'file', listing)).toBe(true);
    expect(existsExact(dir, 'src/pricing', 'any', listing)).toBe(true);
    expect(existsExact(dir, 'src/pricing', 'file', listing)).toBe(false);
    expect(readOf(spy, dir)).toEqual(['', 'src', 'src/pricing']);
  });

  it('reads a directory that is not there once, and says no for everything in it', () => {
    const dir = files();
    const spy = read();
    const listing: Listing = new Map();
    // `src/age.ts` is a file: it cannot be read as a directory.
    expect(existsExact(dir, 'src/age.ts/x.ts', 'file', listing)).toBe(false);
    expect(existsExact(dir, 'src/age.ts/y.ts', 'file', listing)).toBe(false);
    expect(existsExact(dir, 'lib/x.ts', 'file', listing)).toBe(false);
    expect(readOf(spy, dir)).toEqual(['', 'src', 'src/age.ts']);
  });

  it('reads anew without a listing, so that a file created in between is seen', () => {
    const dir = files();
    expect(existsExact(dir, 'src/late.ts')).toBe(false);
    fs.writeFileSync(path.join(dir, 'src/late.ts'), '');
    expect(existsExact(dir, 'src/late.ts')).toBe(true);
    // With one listing for both questions the answer is that of the first reading.
    const listing: Listing = new Map();
    expect(existsExact(dir, 'src/later.ts', 'file', listing)).toBe(false);
    fs.writeFileSync(path.join(dir, 'src/later.ts'), '');
    expect(existsExact(dir, 'src/later.ts', 'file', listing)).toBe(false);
  });
});

describe('test-gates check', () => {
  // Before the listing: 36 readings to load these six gates (each of the three directories for
  // each of the two places a spec may be in, for each gate) and 21 to check them.
  it('reads each directory of the gates once to load the list and once to check it', () => {
    const names = ['age', 'fee', 'rate', 'tax', 'toll', 'zone'];
    const dir = project({
      'test-gates.json': {
        gates: names.map((name) => ({ path: `src/pricing/${name}.ts`, decides: 'd', impact: 'i' })),
        candidates: [{ path: 'src/pricing/later.ts', decides: 'd', impact: 'i', blocker: 'b' }],
      },
      ...Object.fromEntries(
        [...names, 'later'].flatMap((name) => [
          [`src/pricing/${name}.ts`, 'export const value = 1;\n'],
          [`src/pricing/${name}.spec.ts`, "it('x', () => {});\n"],
        ])
      ),
    });
    const spy = read();
    const manifest = readManifest(dir);
    const loaded = readOf(spy, dir);
    expect(checkGates(manifest)).toEqual([]);
    // A second reading of the list starts from nothing: nothing is kept between two calls.
    readManifest(dir);
    const all = readOf(spy, dir);
    const reads = (list: string[], directory: string) =>
      list.filter((entry) => entry === directory).length;
    for (const directory of ['', 'src', 'src/pricing']) {
      expect(reads(loaded, directory)).toBe(1);
      expect(reads(all, directory)).toBe(3);
    }
    expect(loaded).toHaveLength(3);
    expect(all).toHaveLength(9);
  });
});
