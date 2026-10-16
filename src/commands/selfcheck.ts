import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type Shard, UsageError } from '../core/args.js';
import { ManifestError } from '../core/manifest.js';
import { findImporters } from '../core/import-policy.js';
import {
  cleanHold,
  jobFlags,
  jobsPlan,
  jobsRefused,
  knownCommand,
  type Runner,
} from '../core/jobs.js';
import {
  EXCLUDE_ALL_ENV,
  EXCLUDE_ENV,
  judgeSelfcheck,
  planControls,
  quickCaveat,
  quickRefused,
  selectControls,
  sharedRunPrecheck,
} from '../core/selfcheck.js';
import { existsExact, findLocalBin, readText } from '../fs.js';
import { readManifest, type LoadedManifest } from '../load.js';
import { readNotes, TOUCH_ENV } from '../touch.js';
import { loadedFiles } from './loaded-files.js';
import type { Io } from './output.js';

const JEST_CONFIGS = ['js', 'cjs', 'mjs', 'ts', 'cts', 'mts'].map(
  (extension) => `jest.gates.config.${extension}`
);
const VITEST_CONFIGS = ['ts', 'mts', 'cts', 'js', 'mjs', 'cjs'].map(
  (extension) => `vitest.gates.config.${extension}`
);

/** The command that runs the gate: settings.gateCommand, or derived from the gate config file. */
export function resolveGateCommand(manifest: LoadedManifest): string[] {
  if (manifest.settings.gateCommand !== null) {
    return manifest.settings.gateCommand;
  }
  const exists = (name: string) => fs.existsSync(path.join(manifest.dir, name));
  const jest = JEST_CONFIGS.find(exists);
  const vitest = VITEST_CONFIGS.find(exists);
  if (jest && vitest) {
    throw new ManifestError(
      `both ${jest} and ${vitest} exist. Set settings.gateCommand to say which one runs the gate`
    );
  }
  if (jest) {
    return ['jest', '--config', jest];
  }
  if (vitest) {
    return ['vitest', 'run', '--config', vitest];
  }
  throw new ManifestError(
    'no gate config found (jest.gates.config.* / vitest.gates.config.*). Set settings.gateCommand'
  );
}

const TOUCH_PREFIX = '.test-gates-touch-';

function realPath(file: string): string {
  try {
    return fs.realpathSync(file);
  } catch {
    return file;
  }
}

/**
 * The one run that stands in for the runs of all gates no other spec touches.
 *
 * First a full gate run in which each spec writes down what it executed (the helpers do that
 * when asked through TOUCH_ENV; a gate config that does not use them, or the v8 provider of
 * Vitest, writes nothing, and every gate then gets its own run as before). Then one run without
 * the specs of all gates that only their own spec touched.
 *
 * @returns The gates that shared the run and its result, or null when no run was shared.
 */
function shareOneRun<Result extends { status: number | null }>(
  manifest: LoadedManifest,
  targets: LoadedManifest['gates'],
  runGate: (env: { excludeAll?: string[]; touchDir?: string }) => Result
): { gates: LoadedManifest['gates']; result: Result } | { reason: string } {
  let touchDir: string;
  try {
    // A run that was interrupted (Ctrl-C ends this process at once) left its directory behind.
    // An hour is far beyond any gate run, so nothing that is still in use is removed.
    for (const name of fs.readdirSync(manifest.dir)) {
      const left = path.join(manifest.dir, name);
      if (name.startsWith(TOUCH_PREFIX) && Date.now() - fs.statSync(left).mtimeMs > 3_600_000) {
        fs.rmSync(left, { recursive: true, force: true });
      }
    }
    // In the subproject: Vite does not load the provider module from anywhere else (see
    // src/touch.ts).
    touchDir = fs.mkdtempSync(path.join(manifest.dir, TOUCH_PREFIX));
  } catch {
    return { reason: 'the subproject cannot be written to' };
  }
  let plan: ReturnType<typeof planControls>;
  try {
    const recorded = runGate({ touchDir });
    // A gate run that fails as it is (a failing test, a gate below 100%) is no ground to plan
    // on: Vitest, for one, prints no thresholds after a failed test, and leaving out the
    // failing spec with the others would bring them back.
    if (recorded.status !== 0) {
      return { reason: 'the gate run with every spec does not pass' };
    }
    const base = realPath(manifest.dir);
    // Vitest names the files relative to the subproject.
    const absolute = (file: string) => realPath(path.resolve(base, file));
    const rekeyed = <Value>(files: Record<string, Value>) =>
      Object.fromEntries(Object.entries(files).map(([file, value]) => [absolute(file), value]));
    const left = readNotes(touchDir);
    plan = planControls({
      all: manifest.gates.map((gate) => ({
        path: gate.path,
        file: path.join(base, gate.path),
        specFile: path.join(base, gate.spec ?? ''),
      })),
      targets: targets.map((gate) => gate.path),
      run: left.run,
      notes:
        left.notes?.map((note) => ({ spec: absolute(note.spec), files: rekeyed(note.files) })) ??
        null,
      totals: left.totals === null ? null : rekeyed(left.totals),
      failurePattern: manifest.settings.selfcheckFailurePattern,
    });
  } finally {
    fs.rmSync(touchDir, { recursive: true, force: true });
  }
  if (plan.reason !== null) {
    return { reason: plan.reason };
  }
  const together = plan.together;
  const gates = targets.filter((gate) => together.includes(gate.path));
  return { gates, result: runGate({ excludeAll: gates.map((gate) => gate.spec as string) }) };
}

/** Version of an installed package, looked up from `start` upwards; null when it is not found. */
function installedVersion(start: string, name: string): string | null {
  let current = path.resolve(start);
  for (;;) {
    try {
      const manifest = JSON.parse(
        fs.readFileSync(path.join(current, 'node_modules', name, 'package.json'), 'utf8')
      ) as { version?: unknown };
      return typeof manifest.version === 'string' ? manifest.version : null;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        return null;
      }
      current = parent;
    }
  }
}

/** The gate config the gate command names with `--config` (or `-c`); null when it names none. */
function gateConfigFile(args: string[]): string | null {
  const joined = args.find((arg) => arg.startsWith('--config='));
  const position = args.findIndex((arg) => arg === '--config' || arg === '-c');
  return (
    joined?.slice('--config='.length) ?? (position === -1 ? null : (args[position + 1] ?? null))
  );
}

/**
 * Text of the gate config the gate command names with `--config` (or `-c`); null when it
 * names none or the file cannot be read: the config is then not known.
 */
function gateConfigSource(manifest: LoadedManifest, args: string[]): string | null {
  const file = gateConfigFile(args);
  if (file === null) {
    return null;
  }
  try {
    return readText(manifest.dir, file);
  } catch {
    return null;
  }
}

const JOBS_PREFIX = 'test-gates-jobs-';

interface Ended {
  status: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
}

/**
 * Runs the negative controls of `gates`, `jobs` of them at the same time. Each of the `jobs`
 * lines of runs has a directory of its own for what the coverage tool and the runner's cache
 * write (jobFlags), outside of the project.
 *
 * @returns What each run ended with. A run that could not be started has status null. Empty
 *   when no directory could be made: every control then runs on its own.
 */
async function runAtOnce(
  manifest: LoadedManifest,
  gates: LoadedManifest['gates'],
  jobs: number,
  runner: Runner,
  executable: string,
  args: string[]
): Promise<Map<LoadedManifest['gates'][number], Ended>> {
  const results = new Map<LoadedManifest['gates'][number], Ended>();
  let root: string;
  try {
    // A run that was interrupted (Ctrl-C ends this process at once) left its directory behind.
    // An hour is far beyond any gate run, so nothing that is still in use is removed.
    for (const name of fs.readdirSync(os.tmpdir())) {
      const left = path.join(os.tmpdir(), name);
      if (name.startsWith(JOBS_PREFIX) && Date.now() - fs.statSync(left).mtimeMs > 3_600_000) {
        fs.rmSync(left, { recursive: true, force: true });
      }
    }
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), JOBS_PREFIX)));
  } catch {
    return results;
  }
  const queue = [...gates];
  const line = async (dir: string): Promise<void> => {
    for (let gate = queue.shift(); gate !== undefined; gate = queue.shift()) {
      const spec = gate.spec as string;
      results.set(
        gate,
        await new Promise((resolve) => {
          const child = spawn(executable, [...args, ...jobFlags(runner, dir)], {
            cwd: manifest.dir,
            env: { ...process.env, [EXCLUDE_ENV]: spec, [EXCLUDE_ALL_ENV]: '', [TOUCH_ENV]: '' },
            shell: process.platform === 'win32',
          });
          let stdout = '';
          let stderr = '';
          child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
          child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
          child.stdin.on('error', () => undefined);
          child.stdin.end();
          child.on('error', () => resolve({ status: null, signal: null, stdout, stderr }));
          child.on('close', (status, signal) => resolve({ status, signal, stdout, stderr }));
        })
      );
    }
  };
  try {
    await Promise.all(
      Array.from({ length: Math.min(jobs, gates.length) }, (_unused, index) =>
        line(path.join(root, `line-${index}`))
      )
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  return results;
}

/**
 * Negative control. Runs the gate with the spec of one gate left out and requires it to fail
 * on the coverage threshold of that gate. A gate that stays green without its spec measures
 * nothing.
 */
export async function runSelfcheck(
  dir: string,
  selection: {
    mode: 'all' | 'first' | null;
    gates: string[];
    shard: Shard | null;
    quick?: boolean;
    jobs?: number | null;
  },
  commandOverride: string[],
  io: Io
): Promise<number> {
  const refused = selection.quick === true ? quickRefused(process.env) : null;
  if (refused !== null) {
    throw new UsageError(refused);
  }
  const manifest = readManifest(dir);
  if (manifest.violations.length > 0 || manifest.gates.length === 0) {
    io.err('test-gates selfcheck: test-gates.json has problems. Run "test-gates check" first');
    return 1;
  }
  const chosen = selectControls({
    gates: manifest.gates.map((gate) => gate.path),
    mode: selection.mode ?? manifest.settings.selfcheckMode,
    only: selection.gates,
    shard: selection.shard,
  });
  if ('error' in chosen) {
    throw new UsageError(chosen.error);
  }
  const targets = manifest.gates.filter((gate) => chosen.selected.includes(gate.path));
  // Said for --gate and --shard, so that such a run does not read like a run of every gate and
  // a CI log shows which part it was.
  const skipped = manifest.gates.length - targets.length;
  const notSelected =
    selection.shard !== null
      ? `, ${skipped} gate(s) not selected by --shard ${selection.shard.index}/${selection.shard.total}`
      : selection.gates.length > 0
        ? `, ${skipped} gate(s) not selected by --gate`
        : '';
  const command = commandOverride.length > 0 ? commandOverride : resolveGateCommand(manifest);
  const [program, ...args] = command as [string, ...string[]];
  const executable = findLocalBin(manifest.dir, program) ?? program;

  // The three variables are always set, so that one inherited from the caller cannot leak in.
  const runGate = (env: { exclude?: string; excludeAll?: string[]; touchDir?: string }) =>
    spawnSync(executable, args, {
      cwd: manifest.dir,
      env: {
        ...process.env,
        [EXCLUDE_ENV]: env.exclude ?? '',
        [EXCLUDE_ALL_ENV]: env.excludeAll === undefined ? '' : JSON.stringify(env.excludeAll),
        [TOUCH_ENV]: env.touchDir ?? '',
      },
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      shell: process.platform === 'win32',
    });
  const judge = (result: ReturnType<typeof runGate>, gatePath: string) =>
    result.error
      ? `cannot start "${command.join(' ')}" (${result.error.message})`
      : judgeSelfcheck({
          status: result.status,
          output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
          gatePath,
          failurePattern: manifest.settings.selfcheckFailurePattern,
        });

  // Controls that held in the run they shared (see planControls): gate path → exit code.
  const heldTogether = new Map<string, number | null>();
  const single = targets.filter((gate) => gate.spec !== null && gate.existingSpecs.length === 1);
  if (selection.quick === true && single.length >= 3) {
    const configSource = gateConfigSource(manifest, args);
    const shared =
      sharedRunPrecheck({
        program,
        version: installedVersion(manifest.dir, program),
        configSource,
        specs: manifest.gates.flatMap((gate) =>
          gate.existingSpecs.map((spec) => ({ path: spec, source: readText(manifest.dir, spec) }))
        ),
      }) ?? shareOneRun(manifest, single, runGate);
    if (typeof shared === 'string' || 'reason' in shared) {
      const reason = typeof shared === 'string' ? shared : shared.reason;
      io.out(`test-gates selfcheck: a run of the gate command for every gate (${reason})`);
    } else {
      for (const gate of shared.gates) {
        if (judge(shared.result, gate.path) === null) {
          heldTogether.set(gate.path, shared.result.status);
        }
      }
    }
  }

  // Controls that held, cleanly, in a run next to others (see cleanHold): gate path → exit code.
  const heldAtOnce = new Map<string, number | null>();
  const waiting = single.filter((gate) => !heldTogether.has(gate.path));
  const jobs = selection.jobs ?? 1;
  if (jobs > 1 && waiting.length > 1) {
    const known = knownCommand(program, args);
    const refusal = jobsRefused({
      failurePattern: manifest.settings.selfcheckFailurePattern,
      command: known,
      configSource: gateConfigSource(manifest, args),
    });
    if (refusal !== null || !('runner' in known)) {
      io.out(`test-gates selfcheck: one negative control at a time (${refusal})`);
    } else {
      // The files are read only when nothing else stands against it.
      const plan = jobsPlan({
        gates: waiting.map((gate) => ({ path: gate.path, spec: gate.spec as string })),
        ...loadedFiles(manifest, gateConfigFile(args)),
        trusted:
          manifest.settings.importMode === 'allowlist'
            ? manifest.settings.importAllow.flatMap((rule) =>
                rule.module === undefined ? [] : [rule.module]
              )
            : [],
      });
      if (plan.alone.length > 0) {
        // Every one of them and every reason, so that all can be dealt with at once.
        io.out(
          `test-gates selfcheck: ${plan.alone.length} of ${waiting.length} negative control(s) run one at a time, since in their runs something that loads the gate also loads a file that may meet what another run is doing:`
        );
        for (const { gate, reasons } of plan.alone) {
          for (const reason of reasons) {
            io.out(`  ${gate}: ${reason}`);
          }
        }
      }
      const atOnce = waiting.filter((gate) => plan.atOnce.includes(gate.path));
      if (atOnce.length > 1) {
        const specs = new Set(manifest.gates.map((gate) => gate.spec)).size - 1;
        const names = [
          manifest.dir,
          realPath(manifest.dir),
          ...manifest.gates.flatMap((gate) => [gate.path, gate.spec as string]),
        ].sort((left, right) => right.length - left.length);
        const results = await runAtOnce(manifest, atOnce, jobs, known.runner, executable, args);
        for (const [gate, result] of results) {
          const output = `${result.stdout}${result.stderr}`;
          const clean = cleanHold({
            held: judgeSelfcheck({ status: result.status, output, gatePath: gate.path }) === null,
            signal: result.signal,
            output,
            runner: known.runner,
            specs,
            gatePath: gate.path,
            others: manifest.gates
              .map((other) => other.path)
              .filter((other) => other !== gate.path),
            names,
          });
          if (clean) {
            heldAtOnce.set(gate.path, result.status);
          }
        }
        const again = atOnce.length - heldAtOnce.size;
        if (again > 0) {
          io.out(
            `test-gates selfcheck: ${again} of ${atOnce.length} negative control(s) did not hold cleanly next to others and run again on their own`
          );
        }
      }
    }
  }

  let failed = 0;
  for (const gate of targets) {
    if (gate.spec === null || gate.existingSpecs.length !== 1) {
      io.err(`  ✗ ${gate.path}: no single spec to leave out. Run "test-gates check"`);
      failed += 1;
      continue;
    }
    if (heldTogether.has(gate.path)) {
      io.out(
        `  ✓ without ${gate.spec} the gate fails (exit ${heldTogether.get(gate.path)}, in the shared run)`
      );
      continue;
    }
    if (heldAtOnce.has(gate.path)) {
      io.out(`  ✓ without ${gate.spec} the gate fails (exit ${heldAtOnce.get(gate.path)})`);
      continue;
    }
    // On its own, with nothing else running: also every control that did not hold cleanly
    // next to others. This result counts.
    const result = runGate({ exclude: gate.spec });
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    const reason = judge(result, gate.path);
    if (reason === null) {
      io.out(`  ✓ without ${gate.spec} the gate fails (exit ${result.status})`);
    } else {
      failed += 1;
      io.err(`  ✗ ${gate.path}: ${reason}`);
      if (result.status === 0) {
        // The usual cause in a project whose config does honor the variable: another gate
        // imports this one, so that gate's spec covers it.
        const importers = findImporters(
          gate.path,
          manifest.gates
            .filter((other) => existsExact(manifest.dir, other.path))
            .map((other) => ({ path: other.path, source: readText(manifest.dir, other.path) })),
          manifest.settings.importAliases
        );
        if (importers.length > 0) {
          io.err(
            `      hint: ${importers.join(', ')} import(s) this gate, so their specs cover it without its own spec. ` +
              'Mock the import in those specs and assert the call (toHaveBeenCalledWith), so that each spec only covers its own gate'
          );
        }
      }
      const tail = output.trimEnd().split('\n').slice(-25).join('\n');
      if (tail !== '') {
        io.err(tail.replace(/^/gm, '      '));
      }
    }
  }

  if (failed > 0) {
    io.err(
      `test-gates selfcheck: FAILED (${failed} of ${targets.length} negative control(s)${notSelected})${quickCaveat(heldTogether.size)}`
    );
    return 1;
  }
  io.out(
    `test-gates selfcheck: OK (${targets.length} negative control(s) failed as they should${notSelected})${quickCaveat(heldTogether.size)}`
  );
  return 0;
}
