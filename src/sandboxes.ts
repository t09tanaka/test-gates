import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  insideSubproject,
  markerAlive,
  markerName,
  markerText,
  planSandboxes,
  type SandboxPlan,
} from './core/sandboxes.js';

/** Where Stryker keeps its sandboxes, as decideReuse found it. */
export interface TempDirSetting {
  /** The temp directory, absolute; null when the Stryker config could not be loaded. */
  dir: string | null;
  /** The Stryker config sets cleanTempDir: false. */
  keeps: boolean;
}

/** Whether a process with the pid is there. EPERM: it is, but belongs to someone else. */
function there(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * When the process with the pid started, as `ps` prints it (on macOS and Linux alike); null
 * when that cannot be told (no `ps`, as on Windows, or no such process).
 */
export function startedAt(pid: number): string | null {
  const result = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C' },
    timeout: 5_000,
  });
  const started = result.status === 0 ? result.stdout.trim() : '';
  return started === '' ? null : started;
}

/** Whether the run of a marker in `dir` is still there (see markerAlive). */
function alive(dir: string): (pid: number, marker: string) => boolean {
  return (pid, marker) => {
    if (!there(pid)) {
      return false;
    }
    let text: string | null = null;
    try {
      text = fs.readFileSync(path.join(dir, marker), 'utf8');
    } catch {
      // gone meanwhile, or not readable: the pid alone tells
    }
    return markerAlive({ there: true, text, started: startedAt(pid) });
  };
}

/** The temp directory relative to the subproject as the plan takes it, through links. */
function relativeTempDir(subproject: string, dir: string): string {
  let real = dir;
  try {
    real = fs.realpathSync(dir);
  } catch {
    // not there yet: nothing in it either
  }
  return path.relative(fs.realpathSync(subproject), real).split(path.sep).join('/');
}

/** What is left in the temp directory, and what a run would do about it. Changes nothing. */
export function sandboxPlan(
  subproject: string,
  setting: TempDirSetting
): { plan: SandboxPlan; shown: string } {
  const tempDir = setting.dir === null ? null : relativeTempDir(subproject, setting.dir);
  let entries: fs.Dirent[] = [];
  if (setting.dir !== null) {
    try {
      entries = fs.readdirSync(setting.dir, { withFileTypes: true });
    } catch {
      // no temp directory: nothing was left
    }
  }
  const plan = planSandboxes({
    tempDir,
    entries: entries.map((entry) => ({ name: entry.name, directory: entry.isDirectory() })),
    keeps: setting.keeps,
    alive: alive(setting.dir ?? subproject),
  });
  return { plan, shown: tempDir ?? '.stryker-tmp' };
}

/**
 * Removes the sandboxes earlier runs left (see core/sandboxes.ts).
 * @returns The lines to print.
 */
export function removeStaleSandboxes(subproject: string, setting: TempDirSetting): string[] {
  const { plan, shown } = sandboxPlan(subproject, setting);
  if ('kept' in plan) {
    if (plan.kept.length === 0) {
      return [];
    }
    return plan.running === null
      ? [
          `test-gates mutation: ${plan.kept.length} sandbox(es) left in ${shown} by an earlier Stryker run are kept: ${plan.why}`,
        ]
      : [
          `test-gates mutation: ${plan.why}, so the ${plan.kept.length} sandbox(es) in ${shown} are kept: they are in use`,
        ];
  }
  const dir = setting.dir as string;
  for (const marker of plan.markers) {
    try {
      fs.rmSync(path.join(dir, marker), { force: true });
    } catch {
      // the next run tries again; the process in it is gone either way
    }
  }
  const failed: string[] = [];
  for (const sandbox of plan.remove) {
    try {
      fs.rmSync(path.join(dir, sandbox), { recursive: true, force: true });
    } catch (error) {
      failed.push(`${sandbox} (${(error as Error).message})`);
    }
  }
  const removed = plan.remove.length - failed.length;
  return [
    ...(removed > 0
      ? [
          `test-gates mutation: removed ${removed} sandbox(es) an earlier Stryker run left in ${shown}`,
        ]
      : []),
    ...(failed.length > 0
      ? [`test-gates mutation: could not remove from ${shown}: ${failed.join(', ')}`]
      : []),
  ];
}

/**
 * Keeps the marker of this run in the temp directory while Stryker runs, so that a run started
 * meanwhile leaves its sandbox alone. Only in a temp directory inside the subproject: one
 * outside is never cleaned.
 * @returns What removes the marker again.
 */
export function markRun(subproject: string, setting: TempDirSetting): () => void {
  const dir = setting.dir;
  if (dir === null || !insideSubproject(relativeTempDir(subproject, dir))) {
    return () => undefined;
  }
  const marker = path.join(dir, markerName(process.pid));
  try {
    fs.mkdirSync(dir, { recursive: true });
    // Made through a link on the way that leads out of the subproject: write nothing there.
    if (!insideSubproject(relativeTempDir(subproject, dir))) {
      return () => undefined;
    }
    fs.writeFileSync(marker, markerText(process.pid, startedAt(process.pid)));
  } catch {
    return () => undefined;
  }
  return () => {
    try {
      fs.rmSync(marker, { force: true });
      // As Stryker does: the temp directory goes when nothing is left in it.
      fs.rmdirSync(dir);
    } catch {
      // something else is in it, or a marker left here is taken for one of a run that is over
    }
  };
}
