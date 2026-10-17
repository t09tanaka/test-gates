import { describe, expect, it } from 'vitest';
import { insideSubproject, markerName, planSandboxes, type SandboxFacts } from './sandboxes';

const dir = (name: string) => ({ name, directory: true });
const file = (name: string) => ({ name, directory: false });

const facts = (extra: Partial<SandboxFacts> = {}): SandboxFacts => ({
  tempDir: '.stryker-tmp',
  entries: [],
  keeps: false,
  alive: () => false,
  ...extra,
});

describe('insideSubproject', () => {
  it('takes a directory inside the subproject', () => {
    expect(insideSubproject('.stryker-tmp')).toBe(true);
    expect(insideSubproject('tmp/stryker')).toBe(true);
    expect(insideSubproject('.stryker-tmp/..x')).toBe(true);
  });

  it('refuses the subproject itself, a way out of it and an absolute path', () => {
    expect(insideSubproject('')).toBe(false);
    expect(insideSubproject('..')).toBe(false);
    expect(insideSubproject('../shared-tmp')).toBe(false);
    expect(insideSubproject('tmp/../..')).toBe(false);
    expect(insideSubproject('tmp/./x')).toBe(false);
    expect(insideSubproject('tmp//x')).toBe(false);
    expect(insideSubproject('/tmp/stryker')).toBe(false);
    expect(insideSubproject('D:/tmp')).toBe(false);
    expect(insideSubproject('x/D:/tmp')).toBe(true);
  });
});

describe('planSandboxes', () => {
  it('removes only directories named as Stryker names a sandbox', () => {
    const entries = [
      dir('sandbox-Zq81bc'),
      dir('sandbox-a1B2c3'),
      dir('backup-a1B2c3'),
      dir('sandbox-1'),
      dir('sandbox-a1B2c3d'),
      dir('xsandbox-a1B2c3'),
      dir('sandbox-a1B2-3'),
      file('sandbox-abcdef'),
      file('stryker.log'),
    ];
    expect(planSandboxes(facts({ entries }))).toEqual({
      remove: ['sandbox-Zq81bc', 'sandbox-a1B2c3'],
      markers: [],
    });
  });

  it('keeps the sandboxes when the temp directory is not one inside the subproject', () => {
    const entries = [dir('sandbox-a1B2c3')];
    expect(planSandboxes(facts({ tempDir: '../tmp', entries }))).toEqual({
      kept: ['sandbox-a1B2c3'],
      why: 'tempDirName (../tmp) is not a directory inside the subproject',
    });
    expect(planSandboxes(facts({ tempDir: '', entries }))).toEqual({
      kept: ['sandbox-a1B2c3'],
      why: 'tempDirName () is not a directory inside the subproject',
    });
  });

  it('keeps them when where they are cannot be told, or the config keeps them', () => {
    const entries = [dir('sandbox-b1B2c3'), dir('sandbox-a1B2c3')];
    expect(planSandboxes(facts({ tempDir: null, entries }))).toEqual({
      kept: ['sandbox-a1B2c3', 'sandbox-b1B2c3'],
      why: 'the Stryker config could not be loaded to see where they are',
    });
    expect(planSandboxes(facts({ keeps: true, entries }))).toEqual({
      kept: ['sandbox-a1B2c3', 'sandbox-b1B2c3'],
      why: 'the Stryker config sets cleanTempDir: false',
    });
  });

  it('keeps every sandbox while another run is going on, and removes the markers of runs that are over', () => {
    const asked: number[] = [];
    const entries = [
      dir('sandbox-a1B2c3'),
      file(markerName(41)),
      file(markerName(7)),
      file(markerName(99)),
    ];
    const alive = (pid: number) => {
      asked.push(pid);
      return pid === 99;
    };
    expect(planSandboxes(facts({ entries, alive }))).toEqual({
      kept: ['sandbox-a1B2c3'],
      why: 'another test-gates mutation is running in this subproject (pid 99)',
    });
    expect(asked).toEqual([41, 7, 99]);
    expect(planSandboxes(facts({ entries: entries.slice(0, 3), alive }))).toEqual({
      remove: ['sandbox-a1B2c3'],
      markers: ['test-gates-run-41', 'test-gates-run-7'],
    });
  });

  it('takes only a file with the name of a marker for one', () => {
    const asked: number[] = [];
    const alive = (pid: number) => {
      asked.push(pid);
      return true;
    };
    const entries = [
      dir(markerName(5)),
      file('test-gates-run-0'),
      file('test-gates-run-05'),
      file('test-gates-run-5x'),
      file('xtest-gates-run-5'),
      file('test-gates-run-'),
    ];
    expect(planSandboxes(facts({ entries, alive }))).toEqual({ remove: [], markers: [] });
    expect(asked).toEqual([]);
  });
});

describe('markerName', () => {
  it('names the marker by the pid', () => {
    expect(markerName(1234)).toBe('test-gates-run-1234');
  });
});
