// Stryker copies the subproject into a sandbox, `<tempDirName>/sandbox-XXXXXX`, and removes it
// when the run ends. A run that is interrupted (Ctrl-C, a hook that is stopped, a kill) leaves
// it, and the next tool that walks the subproject finds a second copy of every file in it: a
// test runner runs the specs in the sandbox, a script counts it as a project. So a run of
// `test-gates mutation` removes what an earlier run left, before it starts Stryker.
//
// A sandbox that a run going on at the same time still uses must not be removed. Its time does
// not tell: Stryker writes the sandbox once at the start and then only reads it, so the sandbox
// of a run that has gone on for an hour looks as old as one left a week ago. What does tell is a
// marker that each run of test-gates mutation keeps in the temp directory while Stryker runs,
// with the pid of its process. While the process of one is still there, nothing is removed: the
// names of the sandboxes are random, so which one belongs to that run cannot be told. A run that
// was interrupted leaves its marker too, but the process in it is gone. Its pid can be given to
// a new process later, so the marker also holds when the process started: a process with the
// pid that started at another time (more than a few seconds apart) is not the run. Where that
// time cannot be read (no `ps`), a process with the pid is taken for the run.
//
// A Stryker started by hand, not through test-gates, has no marker. Two runs in the same
// subproject at the same time are not meant to happen anyway (they write the same report and
// incremental file); its sandbox is removed like a left one. Only directories named as Stryker
// names a sandbox are removed, never `backup-*` (with inPlace that is the only copy of the
// original files of an interrupted run), and nothing when the temp directory is not one inside
// the subproject.

/** The name Stryker gives a sandbox: `mkdtemp` with `sandbox-`, which adds six characters. */
const SANDBOX = /^sandbox-[A-Za-z0-9]{6}$/;
/** The marker of a run of test-gates mutation, with the pid of its process. */
const MARKER = /^test-gates-run-([1-9][0-9]*)$/;

/** The name of the marker of the run in the process `pid`. */
export function markerName(pid: number): string {
  return `test-gates-run-${pid}`;
}

/** What the marker of a run holds: the pid of its process, and when that started (or ''). */
export function markerText(pid: number, started: string | null): string {
  return `${pid}\n${started ?? ''}\n`;
}

/**
 * Whether the marker of a run belongs to a process that is still there.
 * @param input.there Whether a process with the pid of the marker is there.
 * @param input.text What the marker holds; null when it cannot be read.
 * @param input.started When the process with that pid started; null when it cannot be told.
 */
export function markerAlive(input: {
  there: boolean;
  text: string | null;
  started: string | null;
}): boolean {
  // a marker of an older version holds only the pid
  const recorded = input.text?.split('\n')[1]?.trim() || null;
  return (
    input.there &&
    (recorded === null || input.started === null || sameStart(recorded, input.started))
  );
}

/** Seconds two prints of the start of one process can differ by (see sameStart). */
export const START_SLACK_SECONDS = 5;

/**
 * Whether two prints of when a process started are of the same start. On Linux `ps` counts it
 * from the time of boot, which it takes from the clock and the uptime: two prints of the same
 * process can be a second or more apart. A new process with a reused pid starts later than that.
 */
function sameStart(a: string, b: string): boolean {
  const difference = Math.abs(Date.parse(a) - Date.parse(b));
  // what cannot be read as a time is compared as text
  return Number.isNaN(difference) ? a === b : difference <= START_SLACK_SECONDS * 1000;
}

/** An entry of the temp directory. */
export interface TempEntry {
  name: string;
  /** A directory itself, not a link to one. */
  directory: boolean;
}

export interface SandboxFacts {
  /**
   * The temp directory as Stryker resolves it, relative to the subproject, with `/` (`..` when
   * it is outside; an absolute path when it is on another drive). Null when the Stryker config
   * could not be loaded, so that where it is cannot be told.
   */
  tempDir: string | null;
  /** The entries of the temp directory. */
  entries: TempEntry[];
  /** The Stryker config sets cleanTempDir: false, so its sandboxes are kept on purpose. */
  keeps: boolean;
  /** Whether the run of the marker with this pid and name is still there (see markerAlive). */
  alive: (pid: number, marker: string) => boolean;
}

/** What a run removes before Stryker starts, or why it removes none of the sandboxes. */
export type SandboxPlan =
  | {
      /** The sandboxes to remove, by name. */
      remove: string[];
      /** The markers of runs that are over, by name. */
      markers: string[];
    }
  | {
      /** The sandboxes that are there and are kept. */
      kept: string[];
      why: string;
      /** The pid of a run that is going on, when that is why: its sandbox is in use. */
      running: number | null;
    };

/** Whether `tempDir` is a directory inside the subproject, and not the subproject itself. */
export function insideSubproject(tempDir: string): boolean {
  const parts = tempDir.split('/');
  return (
    !/^[A-Za-z]:/.test(tempDir) &&
    parts.every((part) => part !== '' && part !== '.' && part !== '..')
  );
}

export function planSandboxes(facts: SandboxFacts): SandboxPlan {
  const sandboxes = facts.entries
    .filter((entry) => entry.directory && SANDBOX.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  if (facts.tempDir === null) {
    return {
      kept: sandboxes,
      why: 'the Stryker config could not be loaded to see where they are',
      running: null,
    };
  }
  if (!insideSubproject(facts.tempDir)) {
    return {
      kept: sandboxes,
      why: `tempDirName (${facts.tempDir}) is not a directory inside the subproject`,
      running: null,
    };
  }
  if (facts.keeps) {
    return { kept: sandboxes, why: 'the Stryker config sets cleanTempDir: false', running: null };
  }
  const markers: string[] = [];
  for (const entry of facts.entries) {
    const pid = MARKER.exec(entry.name)?.[1];
    if (pid === undefined || entry.directory) {
      continue;
    }
    if (facts.alive(Number(pid), entry.name)) {
      return {
        kept: sandboxes,
        why: `another test-gates mutation is running in this subproject (pid ${pid})`,
        running: Number(pid),
      };
    }
    markers.push(entry.name);
  }
  return { remove: sandboxes, markers };
}
