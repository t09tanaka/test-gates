import { describe, expect, it } from 'vitest';
import {
  insideSubproject,
  markerAlive,
  markerName,
  markerText,
  planSandboxes,
  type SandboxFacts,
  START_SLACK_SECONDS,
} from './sandboxes';

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
      running: null,
    });
    expect(planSandboxes(facts({ tempDir: '', entries }))).toEqual({
      kept: ['sandbox-a1B2c3'],
      why: 'tempDirName () is not a directory inside the subproject',
      running: null,
    });
  });

  it('keeps them when where they are cannot be told, or the config keeps them', () => {
    const entries = [dir('sandbox-b1B2c3'), dir('sandbox-a1B2c3')];
    expect(planSandboxes(facts({ tempDir: null, entries }))).toEqual({
      kept: ['sandbox-a1B2c3', 'sandbox-b1B2c3'],
      why: 'the Stryker config could not be loaded to see where they are',
      running: null,
    });
    expect(planSandboxes(facts({ keeps: true, entries }))).toEqual({
      kept: ['sandbox-a1B2c3', 'sandbox-b1B2c3'],
      why: 'the Stryker config sets cleanTempDir: false',
      running: null,
    });
  });

  it('keeps every sandbox while another run is going on, and removes the markers of runs that are over', () => {
    const asked: string[] = [];
    const entries = [
      dir('sandbox-a1B2c3'),
      file(markerName(41)),
      file(markerName(7)),
      file(markerName(99)),
    ];
    const alive = (pid: number, marker: string) => {
      asked.push(`${pid} ${marker}`);
      return pid === 99;
    };
    expect(planSandboxes(facts({ entries, alive }))).toEqual({
      kept: ['sandbox-a1B2c3'],
      why: 'another test-gates mutation is running in this subproject (pid 99)',
      running: 99,
    });
    expect(asked).toEqual(['41 test-gates-run-41', '7 test-gates-run-7', '99 test-gates-run-99']);
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

describe('markerText', () => {
  it('holds the pid and when its process started', () => {
    expect(markerText(1234, 'Sat Oct 17 14:25:24 2026')).toBe('1234\nSat Oct 17 14:25:24 2026\n');
    expect(markerText(1234, null)).toBe('1234\n\n');
  });
});

describe('markerAlive', () => {
  const STARTED = 'Sat Oct 17 14:25:24 2026';
  it('takes a marker for one of a run while the process with its pid started when it says', () => {
    expect(markerAlive({ there: true, text: markerText(5, STARTED), started: STARTED })).toBe(true);
    expect(markerAlive({ there: true, text: `5\n  ${STARTED} \n`, started: STARTED })).toBe(true);
    expect(markerAlive({ there: false, text: markerText(5, STARTED), started: STARTED })).toBe(
      false
    );
  });

  it('takes a process with the pid that started at another time for another one', () => {
    expect(
      markerAlive({
        there: true,
        text: markerText(5, STARTED),
        started: 'Sun Oct 18 09:00:00 2026',
      })
    ).toBe(false);
  });

  it('takes prints of the start a few seconds apart for the same start', () => {
    expect(START_SLACK_SECONDS).toBe(5);
    const at = (time: string) =>
      markerAlive({
        there: true,
        text: markerText(5, STARTED),
        started: `Sat Oct 17 ${time} 2026`,
      });
    expect(at('14:25:25')).toBe(true);
    expect(at('14:25:19')).toBe(true);
    expect(at('14:25:29')).toBe(true);
    expect(at('14:25:18')).toBe(false);
    expect(at('14:25:30')).toBe(false);
    // what is not a time: only the same text is the same start
    for (const [recorded, started, same] of [
      ['at boot', 'at boot', true],
      ['at boot', 'later', false],
      [STARTED, 'later', false],
    ] as const) {
      expect(
        markerAlive({ there: true, text: markerText(5, recorded), started: started.trim() })
      ).toBe(same);
    }
  });

  it('takes the process for the run when either started cannot be told', () => {
    for (const text of [null, '5\n', '5', markerText(5, null), '5\n \n']) {
      expect(markerAlive({ there: true, text, started: 'Sun Oct 18 09:00:00 2026' })).toBe(true);
      expect(markerAlive({ there: false, text, started: 'Sun Oct 18 09:00:00 2026' })).toBe(false);
    }
    expect(markerAlive({ there: true, text: markerText(5, STARTED), started: null })).toBe(true);
    expect(markerAlive({ there: false, text: markerText(5, STARTED), started: null })).toBe(false);
  });
});
