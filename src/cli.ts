#!/usr/bin/env node
import { createRequire } from 'node:module';
import { parseArgs, UsageError } from './core/args.js';
import { ManifestError } from './core/manifest.js';
import { runCheck } from './commands/check.js';
import { runDoctor } from './commands/doctor.js';
import { runLcov } from './commands/lcov.js';
import { runMutation } from './commands/mutation.js';
import { runMutationResult } from './commands/mutation-result.js';
import type { Io } from './commands/output.js';
import { runSelfcheck } from './commands/selfcheck.js';

const HELP = `test-gates — test gates for the code that must not be wrong

Usage: test-gates <command> [options]

Commands:
  check                       Static checks of test-gates.json, the gates and their specs
  mutation [-- <args>]        Run the project's Stryker, then judge the result.
                              Unknown arguments and everything after "--" go to Stryker
  mutation-result             Judge an existing Stryker JSON report
  selfcheck [-- <command>]    Negative control: leave one spec out, the gate must fail
  lcov [--file <lcov.info>]   Per-file 100% line coverage from an lcov tracefile
  doctor                      Why a mutation run would not reuse the last results, and what
                              to change. Runs nothing; exit 1 when runs are full ones needlessly

Options:
  --dir <subproject>          Directory that holds test-gates.json (default: .)
  --report <path>             mutation-result: report to judge (default: settings.stryker.reportFile)
  --all | --first             selfcheck: every gate in turn (default) or only the first
  --gate <path>               selfcheck: only this gate (may be given more than once).
                              mutation: only the mutants of this gate, while working on it.
                              Not the final check, and refused when CI is set
  --affected                  mutation: run again only the gates that a change since the last
                              run can affect, and reuse the results of the others. Every
                              mutant is run when CI is set
  --shard <index>/<total>     selfcheck: one of <total> parts of the gates, for parallel CI jobs
  --jobs <n>                  selfcheck: run <n> negative controls at the same time. One that does
                              not hold cleanly there is run again on its own
  --quick                     selfcheck: one run for the gates only their own spec touches.
                              Not the final check: it assumes that no spec depends on which
                              other specs run. Refused when CI is set
  --file <path>               lcov: tracefile (default: settings.lcov.file)
  -h, --help                  Show this help
  -v, --version               Show the version

Exit codes: 0 passed, 1 violations found, 2 wrong usage or unusable test-gates.json
`;

const io: Io = {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
};

function main(argv: string[]): number | Promise<number> {
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
    case 'doctor':
      return runDoctor(args.dir, io);
    case 'mutation':
      return runMutation(args.dir, args.rest, io, args.gates, args.affected);
    case 'mutation-result':
      return runMutationResult(args.dir, args.report, io);
    case 'selfcheck':
      return runSelfcheck(
        args.dir,
        {
          mode: args.mode,
          gates: args.gates,
          shard: args.shard,
          quick: args.quick,
          jobs: args.jobs,
        },
        args.rest,
        io
      );
    case 'lcov':
      return runLcov(args.dir, args.file, io);
    case null:
      throw new UsageError('no command given');
  }
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  if (error instanceof UsageError) {
    io.err(`test-gates: ${error.message}\n`);
    io.err(HELP);
    process.exitCode = 2;
  } else if (error instanceof ManifestError) {
    io.err(`test-gates: ${error.message}`);
    process.exitCode = 2;
  } else {
    throw error;
  }
}
