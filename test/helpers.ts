import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const cliPath = path.join(repoRoot, 'dist', 'cli.js');

const created: string[] = [];

/** Creates a throwaway project. Keys are paths relative to it; objects are written as JSON. */
export function project(files: Record<string, string | object>): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'test-gates-test-')));
  created.push(dir);
  write(dir, files);
  return dir;
}

export function write(dir: string, files: Record<string, string | object>): void {
  for (const [file, content] of Object.entries(files)) {
    const target = path.join(dir, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(
      target,
      typeof content === 'string' ? content : JSON.stringify(content, null, 2)
    );
  }
}

export function cleanup(): void {
  for (const dir of created.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The environment for a run of the CLI in a test. `selfcheck --quick` and `mutation --gate` are
 * refused in CI, and the tests run there too: for a run with one of them, the CI of the machine
 * is taken out.
 * Every other run inherits it; a test that is about CI passes it itself.
 */
function environment(args: string[], extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const inherited = { ...process.env };
  if (
    args.includes('--quick') ||
    (args[0] === 'mutation' && args.some((arg) => /^--gate(=|$)/.test(arg)))
  ) {
    delete inherited.CI;
  }
  return { ...inherited, ...extra };
}

export interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Runs the built CLI. */
export function testGates(
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}
): CliResult {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd: options.cwd ?? repoRoot,
    env: environment(args, options.env),
    encoding: 'utf8',
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/**
 * Runs the built CLI without blocking the test worker. For a run that takes many seconds (a
 * real Stryker): a worker that is blocked for too long cannot report to Vitest and the run fails.
 */
export function testGatesAsync(args: string[], env: NodeJS.ProcessEnv = {}): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: repoRoot,
      env: environment(args, env),
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

export const GATE_SOURCE = [
  'export const isAdult = (age: number) => age >= 18;',
  'export const isSenior = (age: number) => age >= 18;',
  '',
].join('\n');

export const SPEC_SOURCE = [
  "import { isAdult } from './age';",
  "it('is adult at 18', () => { expect(isAdult(18)).toBe(true); });",
  '',
].join('\n');

export const gateEntry = {
  path: 'src/age.ts',
  decides: 'who counts as an adult',
  impact: 'minors get adult pricing',
};

/** A project with one valid gate and its spec. */
export function validProject(
  extra: Record<string, string | object> = {},
  manifest: object = {}
): string {
  return project({
    'test-gates.json': { gates: [gateEntry], candidates: [], ...manifest },
    'src/age.ts': GATE_SOURCE,
    'src/age.spec.ts': SPEC_SOURCE,
    ...extra,
  });
}

/** A Stryker JSON report for GATE_SOURCE: the comparison on line 1 and the one on line 2. */
export function report(first: string, second: string): object {
  const mutant = (status: string, line: number, column: number) => ({
    id: `${line}`,
    mutatorName: 'EqualityOperator',
    replacement: 'age > 18',
    status,
    location: { start: { line, column }, end: { line, column: column + 9 } },
  });
  return {
    schemaVersion: '1.0',
    thresholds: { high: 100, low: 100 },
    files: {
      'src/age.ts': {
        language: 'typescript',
        source: GATE_SOURCE,
        mutants: [mutant(first, 1, 41), mutant(second, 2, 42)],
      },
    },
  };
}
