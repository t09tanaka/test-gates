import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describePlan } from '../core/affected.js';
import { diagnose, formatFindings, type HookUse, hookUses } from '../core/doctor.js';
import { ManifestError } from '../core/manifest.js';
import { readManifest } from '../load.js';
import { sandboxPlan } from '../sandboxes.js';
import { gitEnvironment } from '../snapshot.js';
import { findStrykerConfig } from './check.js';
import { AffectedError, affectedInputs } from '../affected-files.js';
import { decideReuse } from './mutation.js';
import type { Io } from './output.js';

function read(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function git(dir: string, args: string[]): string | null {
  const result = spawnSync('git', args, {
    cwd: dir,
    env: gitEnvironment(process.env),
    encoding: 'utf8',
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

/** The runs of a mutation run of the subproject in the hooks of the repository (see hookUses). */
function hooksOf(dir: string): HookUse[] {
  const root = git(dir, ['rev-parse', '--show-toplevel']) ?? dir;
  const hooksDir = git(dir, ['rev-parse', '--path-format=absolute', '--git-path', 'hooks']);
  const candidates = [
    ...['pre-push', 'pre-commit'].map((name) => path.join(root, '.husky', name)),
    ...(hooksDir === null
      ? []
      : ['pre-push', 'pre-commit'].map((name) => path.join(hooksDir, name))),
    ...['lefthook.yml', '.lefthook.yml'].map((name) => path.join(root, name)),
  ];
  let script = '';
  try {
    const manifest = JSON.parse(read(path.join(dir, 'package.json')) ?? '{}') as {
      scripts?: Record<string, string>;
    };
    script = manifest.scripts?.['test:gates:mutation'] ?? '';
  } catch {
    // no scripts to look at
  }
  const subproject = path.relative(fs.realpathSync(root), dir).split(path.sep).join('/');
  const seen = new Set<string>();
  const uses: HookUse[] = [];
  for (const file of candidates) {
    const text = read(file);
    if (text === null) {
      continue;
    }
    const real = fs.realpathSync(file);
    if (seen.has(real)) {
      continue;
    }
    seen.add(real);
    const shown = path.relative(root, file).split(path.sep).join('/');
    uses.push(...hookUses({ file: shown, text, subproject, script }));
  }
  return uses;
}

/**
 * Tells why `test-gates mutation` would not reuse the results of the last run, and what to
 * change. Runs nothing and changes nothing.
 */
export function runDoctor(dir: string, io: Io): number {
  const manifest = readManifest(dir);
  const config = findStrykerConfig(manifest);
  if (config === null) {
    throw new ManifestError(
      'no Stryker config found (stryker.gates.config.mjs). Create one, or set settings.stryker.configFile'
    );
  }
  const plain = decideReuse(manifest, config, [], false, false);
  const affected = decideReuse(manifest, config, [], false, true);
  io.out(`test-gates doctor: ${manifest.dir} (${config})`);
  if (plain.snapshot !== null) {
    const subproject = path.relative(plain.root, fs.realpathSync(manifest.dir));
    const prefix = subproject === '' ? '' : `${subproject.split(path.sep).join('/')}/`;
    const keys = Object.keys(plain.snapshot.files);
    const outside = keys.filter((key) => !key.startsWith(prefix)).length;
    const followed =
      plain.scope === null
        ? ''
        : 'files' in plain.scope
          ? `, paths followed in the ${plain.scope.files} files the run loads`
          : ', paths followed in every file';
    io.out(`  compared: ${keys.length} files, ${outside} outside the subproject${followed}`);
  }
  if (plain.incremental) {
    const reuse = plain.forced
      ? 'the Stryker config sets force'
      : (plain.force ??
        (plain.incrementalHash === null ? 'there is no incremental file of an earlier run' : null));
    io.out(
      reuse === null
        ? '  next run: reuses the results of the last run'
        : `  next run: every mutant, ${reuse}`
    );
    // A new linked worktree has no record of its own (see decideReuse).
    if (plain.seed !== null) {
      io.out(
        `  this worktree has no record of its own: the next run starts from the one of the main worktree (${plain.mainWorktree})`
      );
    } else if (plain.mainWorktree !== null) {
      io.out(
        `  this worktree has no record of its own, and the main worktree (${plain.mainWorktree}) has none this worktree can start from`
      );
    }
    if (affected.ci !== null) {
      io.out(`  next run with --affected: every mutant, ${affected.ci}`);
    } else if (affected.plan !== null && 'rerun' in affected.plan) {
      const [first = '', ...rest] = describePlan(affected.plan);
      io.out(
        `  next run with --affected: ${first.replace(/^test-gates mutation --affected: /, '')}`
      );
      rest.forEach((line) => io.out(`  ${line}`));
    } else if (affected.unchanged !== null) {
      io.out('  next run with --affected: reuses the results of the last run (nothing changed)');
    } else {
      const why = affected.forced ? 'the Stryker config sets force' : affected.force;
      io.out(`  next run with --affected: every mutant, ${why ?? 'there is nothing to reuse'}`);
    }
  }
  // Whether --affected can tell the gates apart, whatever the record holds.
  let blind: string | null = null;
  let blindGates: Array<{ gate: string; reason: string }> = [];
  if (plain.snapshot !== null) {
    try {
      const inputs = affectedInputs(manifest, {
        root: plain.root,
        files: plain.snapshot.files,
        configs: plain.configs(),
        tests: [],
        covering: {},
      });
      blindGates = manifest.gates.flatMap((gate) => {
        const reason = inputs.gates[gate.path]?.blind;
        return reason === undefined ? [] : [{ gate: gate.path, reason }];
      });
    } catch (error) {
      if (!(error instanceof AffectedError)) {
        throw error;
      }
      blind = error.message;
    }
  }
  const left = sandboxPlan(manifest.dir, plain.temp);
  const count = 'kept' in left.plan ? left.plan.kept.length : left.plan.remove.length;
  const { lines, status } = formatFindings(
    diagnose({
      incremental: plain.incremental,
      forced: plain.forced,
      failure: plain.failure,
      widened: plain.widened,
      scope: plain.scope,
      hooks: hooksOf(fs.realpathSync(manifest.dir)),
      blind,
      blindGates,
      gates: manifest.gates.length,
      sandboxes:
        count === 0
          ? null
          : {
              tempDir: left.shown,
              count,
              kept: 'kept' in left.plan ? left.plan.why : null,
            },
    })
  );
  lines.forEach((line) => io.out(line));
  return status;
}
