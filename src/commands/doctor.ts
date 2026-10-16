import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describePlan } from '../core/affected.js';
import { diagnose, formatFindings, type HookUse } from '../core/doctor.js';
import { ManifestError } from '../core/manifest.js';
import { readManifest } from '../load.js';
import { gitEnvironment } from '../snapshot.js';
import { findStrykerConfig } from './check.js';
import { decideReuse } from './mutation.js';
import type { Io } from './output.js';

const RUNS_MUTATION = /test-gates(?:\.js)?\s+mutation\b|test:gates:mutation\b/;

function read(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** The hooks of the repository that run a mutation run, and whether they pass --affected. */
function hooksOf(root: string, dir: string): HookUse[] {
  const result = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-path', 'hooks'], {
    cwd: dir,
    env: gitEnvironment(process.env),
    encoding: 'utf8',
  });
  const hooksDir = result.status === 0 ? result.stdout.trim() : null;
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
  const seen = new Set<string>();
  const hooks: HookUse[] = [];
  for (const file of candidates) {
    const text = read(file);
    if (text === null || !RUNS_MUTATION.test(text)) {
      continue;
    }
    const real = fs.realpathSync(file);
    if (seen.has(real)) {
      continue;
    }
    seen.add(real);
    hooks.push({
      file: path.relative(root, file).split(path.sep).join('/'),
      affected:
        text.includes('--affected') ||
        (/test:gates:mutation\b/.test(text) && script.includes('--affected')),
    });
  }
  return hooks;
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
    const reuse =
      plain.force ??
      (plain.incrementalHash === null ? 'there is no incremental file of an earlier run' : null);
    io.out(
      reuse === null
        ? '  next run: reuses the results of the last run'
        : `  next run: every mutant, ${reuse}`
    );
    if (affected.ci !== null) {
      io.out(`  next run with --affected: every mutant, ${affected.ci}`);
    } else if (affected.plan !== null && 'rerun' in affected.plan) {
      const [first = '', ...rest] = describePlan(affected.plan);
      io.out(
        `  next run with --affected: ${first.replace(/^test-gates mutation --affected: /, '')}`
      );
      rest.forEach((line) => io.out(`  ${line}`));
    } else {
      io.out(
        `  next run with --affected: every mutant, ${affected.force ?? 'there is nothing to reuse'}`
      );
    }
  }
  const { lines, status } = formatFindings(
    diagnose({
      incremental: plain.incremental,
      failure: plain.failure,
      widened: plain.widened,
      scope: plain.scope,
      hooks: hooksOf(plain.root, fs.realpathSync(manifest.dir)),
    })
  );
  lines.forEach((line) => io.out(line));
  return status;
}
