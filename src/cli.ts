#!/usr/bin/env node
import { createRequire } from 'node:module';
import { parseArgs, UsageError } from './core/args.js';
import { ManifestError } from './core/manifest.js';
import { runCheck } from './commands/check.js';
import { runLcov } from './commands/lcov.js';
import { runMutation } from './commands/mutation.js';
import { runMutationResult } from './commands/mutation-result.js';
import type { Io } from './commands/output.js';
import { runSelfcheck } from './commands/selfcheck.js';

const HELP = `sekisho — test gates for the code that must not be wrong

Usage: sekisho <command> [options]

Commands:
  check                       Static checks of test-gates.json, the gates and their specs
  mutation [-- <args>]        Run the project's Stryker, then judge the result.
                              Unknown arguments and everything after "--" go to Stryker
  mutation-result             Judge an existing Stryker JSON report
  selfcheck [-- <command>]    Negative control: leave one spec out, the gate must fail
  lcov --file <lcov.info>     Per-file 100% line coverage from an lcov tracefile

Options:
  --dir <subproject>          Directory that holds test-gates.json (default: .)
  --report <path>             mutation-result: report to judge (default: settings.stryker.reportFile)
  --all | --first             selfcheck: every gate in turn (default) or only the first
  --file <path>               lcov: tracefile (default: settings.lcov.file)
  -h, --help                  Show this help
  -v, --version               Show the version

Exit codes: 0 passed, 1 violations found, 2 wrong usage or unusable test-gates.json
`;

const io: Io = {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
};

function main(argv: string[]): number {
  const args = parseArgs(argv);
  if (args.version) {
    const { version } = createRequire(import.meta.url)('../package.json') as { version: string };
    io.out(version);
    return 0;
  }
  if (args.help) {
    io.out(HELP);
    return 0;
  }
  switch (args.command) {
    case 'check':
      return runCheck(args.dir, io);
    case 'mutation':
      return runMutation(args.dir, args.rest, io);
    case 'mutation-result':
      return runMutationResult(args.dir, args.report, io);
    case 'selfcheck':
      return runSelfcheck(args.dir, args.mode, args.rest, io);
    case 'lcov':
      return runLcov(args.dir, args.file, io);
    case null:
      throw new UsageError('no command given');
  }
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  if (error instanceof UsageError) {
    io.err(`sekisho: ${error.message}\n`);
    io.err(HELP);
    process.exitCode = 2;
  } else if (error instanceof ManifestError) {
    io.err(`sekisho: ${error.message}`);
    process.exitCode = 2;
  } else {
    throw error;
  }
}
