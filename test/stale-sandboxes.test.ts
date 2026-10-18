import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { startedAt } from '../src/sandboxes';
import {
  cleanup,
  GATE_SOURCE,
  gateEntry,
  project,
  report,
  SPEC_SOURCE,
  testGates,
} from './helpers';

afterAll(cleanup);

// A stand-in for node_modules/.bin/stryker. It writes down what was in the temp directory
// (TEMP_DIR, `.stryker-tmp` by default) when it started, and writes a report. With TIMES_OUT=1
// a mutant times out in the first run, so that its timeouts are run again.
const FAKE_STRYKER = `#!/usr/bin/env node
const fs = require('node:fs');
const temp = process.env.TEMP_DIR || '.stryker-tmp';
fs.mkdirSync('reports/mutation', { recursive: true });
const again = process.argv.includes('--concurrency');
fs.writeFileSync(again ? 'reports/seen-again.json' : 'reports/seen.json', JSON.stringify(fs.existsSync(temp) ? fs.readdirSync(temp).sort() : []));
const markers = (fs.existsSync(temp) ? fs.readdirSync(temp) : []).filter((name) => name.startsWith('test-gates-run-'));
fs.writeFileSync('reports/markers.json', JSON.stringify(markers.map((name) => fs.readFileSync(temp + '/' + name, 'utf8'))));
const timesOut = process.env.TIMES_OUT === '1' && !again;
fs.writeFileSync('reports/mutation/mutation.json', timesOut ? ${JSON.stringify(JSON.stringify(report('Timeout', 'Killed')))} : ${JSON.stringify(JSON.stringify(report('Killed', 'Killed')))});
`;

const LEFT = '.stryker-tmp/sandbox-a1B2c3';

function create(files: Record<string, string | object> = {}): string {
  const dir = project({
    'test-gates.json': { gates: [gateEntry], candidates: [] },
    'package.json': { name: 'fixture', private: true },
    'src/age.ts': GATE_SOURCE,
    'src/age.spec.ts': SPEC_SOURCE,
    'stryker.gates.config.mjs': 'export default {};\n',
    'node_modules/.bin/stryker': FAKE_STRYKER,
    [`${LEFT}/src/age.spec.ts`]: SPEC_SOURCE,
    ...files,
  });
  fs.chmodSync(path.join(dir, 'node_modules/.bin/stryker'), 0o755);
  return dir;
}

const exists = (dir: string, file: string) => fs.existsSync(path.join(dir, file));
const seen = (dir: string, file = 'reports/seen.json'): string[] =>
  JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) as string[];

/** The pid of a process that is over. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', ''], {});
  return child.pid as number;
}

describe('test-gates mutation: sandboxes an interrupted run left', () => {
  it('removes them before Stryker starts, and keeps a marker of the run while it runs', () => {
    const dead = `test-gates-run-${deadPid()}`;
    const dir = create({
      '.stryker-tmp/sandbox-Zz9yX8/package.json': '{}',
      '.stryker-tmp/backup-a1B2c3/src/age.ts': GATE_SOURCE,
      '.stryker-tmp/sandbox-1/x': 'x',
      [`.stryker-tmp/${dead}`]: '1\n',
    });
    const result = testGates(['mutation', '--dir', dir]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      'test-gates mutation: removed 2 sandbox(es) an earlier Stryker run left in .stryker-tmp'
    );
    expect(exists(dir, LEFT)).toBe(false);
    expect(exists(dir, '.stryker-tmp/sandbox-Zz9yX8')).toBe(false);
    // Not named as Stryker names a sandbox: kept. backup-* holds the original files of a run
    // in place.
    expect(exists(dir, '.stryker-tmp/backup-a1B2c3/src/age.ts')).toBe(true);
    expect(exists(dir, '.stryker-tmp/sandbox-1/x')).toBe(true);
    const marker = seen(dir).filter((name) => name.startsWith('test-gates-run-'));
    expect(seen(dir)).toEqual(['backup-a1B2c3', 'sandbox-1', ...marker].sort());
    expect(marker).toHaveLength(1);
    expect(marker[0]).not.toBe(dead);
    // The marker goes when Stryker is over.
    expect(fs.readdirSync(path.join(dir, '.stryker-tmp')).sort()).toEqual([
      'backup-a1B2c3',
      'sandbox-1',
    ]);
  });

  it('keeps the marker while the timeouts are run again, too', () => {
    const dir = create();
    const result = testGates(['mutation', '--dir', dir], { env: { TIMES_OUT: '1' } });
    expect(result.stdout).toContain('running them again one at a time');
    const [marker] = seen(dir);
    expect(marker).toMatch(/^test-gates-run-[0-9]+$/);
    expect(seen(dir, 'reports/seen-again.json')).toEqual([marker]);
    expect(exists(dir, '.stryker-tmp')).toBe(false);
  });

  it('removes the temp directory that is left empty, as Stryker does', () => {
    const dir = create();
    expect(testGates(['mutation', '--dir', dir]).status).toBe(0);
    expect(exists(dir, '.stryker-tmp')).toBe(false);
  });

  it('keeps them while another run is going on in the subproject', () => {
    // The process of this test is still there.
    const dir = create({ [`.stryker-tmp/test-gates-run-${process.pid}`]: '1\n' });
    const result = testGates(['mutation', '--dir', dir]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      `test-gates mutation: another test-gates mutation is running in this subproject (pid ${process.pid}), so the 1 sandbox(es) in .stryker-tmp are kept: they are in use`
    );
    expect(exists(dir, `${LEFT}/src/age.spec.ts`)).toBe(true);
    expect(exists(dir, `.stryker-tmp/test-gates-run-${process.pid}`)).toBe(true);
    // The same with the time its process started, as a marker of this version holds it.
    const started = startedAt(process.pid) as string;
    expect(started).toMatch(/[0-9]{4}$/);
    const marked = create({
      [`.stryker-tmp/test-gates-run-${process.pid}`]: `${process.pid}\n${started}\n`,
    });
    expect(testGates(['mutation', '--dir', marked]).stdout).toContain('they are in use');
    expect(exists(marked, LEFT)).toBe(true);
  });

  it('takes a marker whose pid now belongs to a process that started at another time for one of a run that is over', () => {
    const marker = `.stryker-tmp/test-gates-run-${process.pid}`;
    const dir = create({ [marker]: `${process.pid}\nMon Jan  1 00:00:00 2001\n` });
    const result = testGates(['mutation', '--dir', dir]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('removed 1 sandbox(es) an earlier Stryker run left');
    expect(exists(dir, LEFT)).toBe(false);
    expect(exists(dir, marker)).toBe(false);
  });

  it('writes when its process started into the marker of the run', () => {
    const dir = create();
    expect(testGates(['mutation', '--dir', dir]).status).toBe(0);
    const [text] = JSON.parse(
      fs.readFileSync(path.join(dir, 'reports/markers.json'), 'utf8')
    ) as string[];
    const [pid, started] = (text as string).split('\n');
    expect(Number(pid)).toBeGreaterThan(0);
    // as \`ps -o lstart=\` prints it; the process is over by now
    expect(started).toMatch(
      /^[A-Z][a-z]{2} [A-Z][a-z]{2} [ 0-9][0-9] [0-9]{2}:[0-9]{2}:[0-9]{2} [0-9]{4}$/
    );
  });

  it('keeps them when the Stryker config keeps its sandboxes', () => {
    const dir = create({ 'stryker.gates.config.mjs': 'export default { cleanTempDir: false };\n' });
    const result = testGates(['mutation', '--dir', dir]);
    expect(result.stdout).toContain('are kept: the Stryker config sets cleanTempDir: false');
    expect(exists(dir, LEFT)).toBe(true);
  });

  it('removes nothing in a temp directory outside the subproject', () => {
    const root = project({ 'shared-tmp/sandbox-a1B2c3/x': 'x' });
    const dir = create({
      'stryker.gates.config.mjs': `export default { tempDirName: ${JSON.stringify(path.join(root, 'shared-tmp'))} };\n`,
    });
    const result = testGates(['mutation', '--dir', dir], {
      env: { TEMP_DIR: path.join(root, 'shared-tmp') },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('is not a directory inside the subproject');
    expect(exists(root, 'shared-tmp/sandbox-a1B2c3/x')).toBe(true);
    // No marker is written there either.
    expect(seen(dir)).toEqual(['sandbox-a1B2c3']);
  });

  it('removes nothing through a temp directory that is a link out of the subproject', () => {
    const root = project({ 'shared-tmp/sandbox-a1B2c3/x': 'x' });
    const dir = create();
    fs.rmSync(path.join(dir, '.stryker-tmp'), { recursive: true });
    fs.symlinkSync(path.join(root, 'shared-tmp'), path.join(dir, '.stryker-tmp'));
    const result = testGates(['mutation', '--dir', dir]);
    expect(result.stdout).toContain('is not a directory inside the subproject');
    expect(exists(root, 'shared-tmp/sandbox-a1B2c3/x')).toBe(true);
  });

  it('removes them with the temp directory given to Stryker as an argument', () => {
    const dir = create({ 'tmp/stryker/sandbox-q1W2e3/x': 'x' });
    const result = testGates(['mutation', '--dir', dir, '--', '--tempDirName', 'tmp/stryker'], {
      env: { TEMP_DIR: 'tmp/stryker' },
    });
    expect(result.stdout).toContain(
      'removed 1 sandbox(es) an earlier Stryker run left in tmp/stryker'
    );
    expect(exists(dir, 'tmp/stryker/sandbox-q1W2e3')).toBe(false);
    // The default one is not the temp directory of this run.
    expect(exists(dir, LEFT)).toBe(true);
  });
});

describe('test-gates doctor: sandboxes an interrupted run left', () => {
  it('notes them and changes nothing', () => {
    const dir = create({ 'stryker.gates.config.mjs': 'export default { incremental: true };\n' });
    const result = testGates(['doctor', '--dir', dir]);
    expect(result.stdout).toContain(
      'note: 1 sandbox(es) an interrupted Stryker run left in .stryker-tmp: a tool that walks the subproject (a test runner, a script) finds a copy of every file in them'
    );
    expect(result.stdout).toContain('  fix: the next test-gates mutation removes them');
    expect(exists(dir, `${LEFT}/src/age.spec.ts`)).toBe(true);
  });

  it('says that they are in use while another run is going on', () => {
    const dir = create({
      'stryker.gates.config.mjs': 'export default { incremental: true };\n',
      [`.stryker-tmp/test-gates-run-${process.pid}`]: `${process.pid}\n${startedAt(process.pid)}\n`,
    });
    const result = testGates(['doctor', '--dir', dir]);
    expect(result.stdout).toContain(
      `note: another test-gates mutation is running in this subproject (pid ${process.pid}): the 1 sandbox(es) in .stryker-tmp are in use`
    );
    expect(result.stdout).not.toContain('interrupted');
    expect(result.stdout).not.toContain('by hand');
  });
});
