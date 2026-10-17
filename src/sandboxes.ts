import fs from 'node:fs';
import path from 'node:path';
import { insideSubproject, markerName, planSandboxes, type SandboxPlan } from './core/sandboxes.js';

/** Where Stryker keeps its sandboxes, as decideReuse found it. */
export interface TempDirSetting {
  /** The temp directory, absolute; null when the Stryker config could not be loaded. */
  dir: string | null;
  /** The Stryker config sets cleanTempDir: false. */
  keeps: boolean;
}

/** Whether the process is still there. EPERM: it is, but belongs to someone else. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
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
    alive,
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
    return plan.kept.length === 0
      ? []
      : [
          `test-gates mutation: ${plan.kept.length} sandbox(es) left in ${shown} by an earlier Stryker run are kept: ${plan.why}`,
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
    fs.writeFileSync(marker, `${process.pid}\n`);
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
