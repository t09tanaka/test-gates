# test-gates

[![CI](https://github.com/t09tanaka/test-gates/actions/workflows/ci.yml/badge.svg)](https://github.com/t09tanaka/test-gates/actions/workflows/ci.yml)

Test gates for the code that must not be wrong.

This package guards the handful of modules where a wrong decision costs money or trust: amounts and rounding, state transitions of payments and orders, authentication and role checks, expiry and remaining-quota rules.

- **100% coverage is only the floor.** It proves that a test exists and touches every branch. It does not prove that the test checks the decision.
- **Mutation testing is the real check.** If the code can be changed without a test failing, the decision is not guarded. Every surviving mutant must be killed by a test, or allowed one by one with a written reason.
- **Important decisions live in pure modules, and pure modules are registered.** No decorators, no DI, no database, no framework runtime. The list of registered modules is one file: `test-gates.json`.

`test-gates` is a CLI plus three small config helpers. It has no runtime dependencies. Jest, Vitest and Stryker are the ones already installed in your project.

### When this is worth it, and when it is not

It pays off when the same rule has to hold in several places: a monorepo with several subprojects, or several repositories, where a copied script would drift. One `test-gates.json` per subproject, the same commands everywhere, the same verdict.

It does little when

- you have one project and one script already does the job. A script you understand is fine; this package is that script, made uniform.
- the decisions are not in pure modules yet. In a codebase that is mostly decorators and dependency injection, the important logic ends up under `candidates`, and **nothing is enforced for a candidate**. The package then only gives you the list of what to extract first. The enforcement starts when a decision has been moved into a pure module.

## Install

```bash
npm install -D @t09tanaka/test-gates
```

Requires Node.js 20 or later. For mutation testing add Stryker and the runner for your test framework:

```bash
npm install -D @stryker-mutator/core @stryker-mutator/jest-runner    # or @stryker-mutator/vitest-runner
```

## Setup

Everything below is per subproject (the directory that has a `package.json`: `backend/`, `frontend/`, `api/`, ...).

### 1. `test-gates.json`

```json
{
  "$schema": "./node_modules/@t09tanaka/test-gates/schema/test-gates.schema.json",
  "gates": [
    {
      "path": "src/shipping-fee.ts",
      "decides": "The fee for sending a parcel, by weight, and its maximum",
      "impact": "A heavy parcel is sent for too little, or the customer pays more than the advertised maximum"
    }
  ],
  "candidates": [
    {
      "path": "src/warehouse/dispatch.guard.ts",
      "decides": "Who may release an order for dispatch",
      "blocker": "Has decorators. The decision has to be extracted into a pure module"
    }
  ]
}
```

- `gates`: pure modules that hold an important decision. Each one needs a spec next to it (`shipping-fee.spec.ts` or `shipping-fee.test.ts`), 100% on statements, branches, functions and lines, and no surviving mutant outside its allow list.
- `candidates`: important logic that cannot be a gate yet, with what blocks it. Nothing is enforced for these except that the path exists.
- `settings`: optional project conventions, see [Settings](#settings).

This file is the only place where the list lives. The configs below are derived from it.

### 2. Gate config: only the specs of the gates, only the gates measured

Jest (`jest.gates.config.js`):

```js
const { createJestGatesConfig } = require('@t09tanaka/test-gates/jest');

module.exports = createJestGatesConfig({
  rootDir: __dirname,
  transform: { '^.+\\.ts$': ['ts-jest', { diagnostics: false }] },
  moduleNameMapper: { '^@/(.*)$': '<rootDir>/src/$1' },
});
```

Vitest (`vitest.gates.config.ts`):

```ts
import { defineConfig } from 'vitest/config';
import { createVitestGatesConfig } from '@t09tanaka/test-gates/vitest';

export default defineConfig(
  createVitestGatesConfig({
    rootDir: import.meta.url,
    resolve: { alias: { '@': new URL('./src', import.meta.url).pathname } },
  })
);
```

Do not use a database, a custom test environment or a global setup here. A spec that needs them does not verify a pure module; move the file to `candidates`.

### 3. Stryker config (`stryker.gates.config.mjs`)

```js
import { createStrykerGatesConfig } from '@t09tanaka/test-gates/stryker';

export default createStrykerGatesConfig({
  rootDir: import.meta.url,
  testRunner: 'jest',
  jest: { projectType: 'custom', configFile: 'jest.gates.config.js' },
  // testRunner: 'vitest', vitest: { configFile: 'vitest.gates.config.ts' },
  concurrency: 2,
});
```

Add `reports/`, `.stryker-tmp/` and `.test-gates-touch-*` (see `test-gates selfcheck`) to `.gitignore`.

### 4. Scripts

```json
{
  "scripts": {
    "test:gates": "test-gates check && jest --config jest.gates.config.js",
    "test:gates:mutation": "test-gates mutation",
    "test:gates:selfcheck": "test-gates selfcheck"
  }
}
```

With Vitest, `test:gates` is `test-gates check && vitest run --config vitest.gates.config.ts`.

Arguments after `--` go to Stryker and nowhere else:

```bash
npm run test:gates:mutation -- --force --concurrency 1
```

### 5. Where to run it

pre-push (husky), only for the subprojects the push touches:

```sh
#!/bin/sh
default_branch=$(git symbolic-ref -q --short refs/remotes/origin/HEAD || echo origin/main)
changed=""
while read -r _local_ref local_sha _remote_ref remote_sha; do
  case "$local_sha" in *[!0]*) ;; *) continue ;; esac   # branch deletion
  if git cat-file -e "$remote_sha^{commit}" 2>/dev/null; then
    base="$remote_sha"
  else
    base=$(git merge-base "$local_sha" "$default_branch" 2>/dev/null || true)
  fi
  if [ -n "$base" ]; then
    changed="$changed
$(git diff --name-only "$base" "$local_sha")"
  else
    changed="$changed
$(git ls-tree -r --name-only "$local_sha")"
  fi
done

for project in backend frontend; do
  printf '%s\n' "$changed" | grep -q "^$project/" || continue
  (cd "$project" && npm run --silent test:gates && npm run --silent test:gates:mutation) || exit 1
done
```

CI (GitHub Actions), one job per subproject, no database service needed:

```yaml
test-gates:
  runs-on: ubuntu-latest
  defaults:
    run:
      working-directory: backend
  steps:
    - uses: actions/checkout@v4
    - uses: actions/setup-node@v4
      with:
        node-version-file: backend/.node-version
        cache: npm
        cache-dependency-path: backend/package-lock.json
    - run: npm ci
    - run: npm run test:gates
    - run: npm run test:gates:selfcheck
    - run: npm run test:gates:mutation
```

When the negative control takes too long with many gates, run it as a job of its own, in parts (`--shard`, see `test-gates selfcheck` under [Commands](#commands)):

```yaml
test-gates-selfcheck:
  runs-on: ubuntu-latest
  strategy:
    fail-fast: false
    matrix:
      part: [1, 2, 3, 4]
  defaults:
    run:
      working-directory: backend
  steps:
    # checkout, setup-node and npm ci as above
    - run: npm run test:gates:selfcheck -- --shard ${{ matrix.part }}/4
```

The number of parts is written twice, in `matrix.part` and after the `/`; keep the two in step. The `test:gates:selfcheck` script must not itself end in `-- <gate command>`, or the option would land behind it (which is refused); put the command into `settings.gateCommand` instead.

## Commands

All commands take `--dir <subproject>` (default: the current directory). `test-gates -h` (`--help`) prints the usage and `test-gates -v` (`--version`) the version.

| Exit code | Meaning                                                                    |
| --------- | -------------------------------------------------------------------------- |
| 0         | Passed                                                                     |
| 1         | Violations found, or a run that could not be judged (e.g. missing report)  |
| 2         | Wrong usage, or `test-gates.json` is missing, broken or has an unknown key |

### `test-gates check`

Static checks, before the gate run. Reports every violation as `file:line: reason`.

- Every gate exists, and so does its spec. **The check is case-sensitive** even on macOS and Windows, because CI on Linux is.
- No path is listed twice, or in both `gates` and `candidates`. Candidates exist.
- A gate has no decorator (`@Name(` at the start of a line) and no runtime import of a framework, database client or SDK. `import type` is ignored.
- A gate does not read `process.env` (since 0.3.0). What comes from the environment is an input: take it as an argument.
- A gate and its spec have no coverage ignore directive (`istanbul ignore`, `c8 ignore`, `v8 ignore`).
- A spec has no `.skip`, `.only`, `.todo`, `xit`, `xdescribe`, `fit`, `fdescribe`, `.skipIf`, `.runIf`, `.fails`.
- A spec does not `jest.mock` / `vi.mock` the module it is supposed to test.
- A gate has no `Stryker disable` / `Stryker restore` comment. Such a comment turns off a whole line for a whole mutator, which takes non-equivalent mutants out with it.
- `equivalentMutants` entries are well formed and each has a `reason`.
- The Stryker config does not use `excludedMutations`, `ignoreStatic` or `ignorers`.
- A Vitest gate run below Vitest 4 does not use the plain v8 coverage provider (since 0.3.0), see [Vitest: v8 or istanbul](#vitest-v8-or-istanbul).

### `test-gates mutation [-- <stryker arguments>]`

Runs `stryker run <config>` from the project's own `node_modules`, then judges the JSON report (see `mutation-result`). Unknown arguments, and everything after `--`, are handed to Stryker. If Stryker itself fails, the exit code is 1 and nothing is judged. A report from an earlier run is deleted first, so a run that writes none cannot pass on old results.

#### When the results of the last run are reused

In Stryker's incremental mode (the helper turns it on) a run reuses the old result of a mutant when the text at the place of the mutant is the same and a test that killed it is the same. That is less than it sounds. Measured with Stryker 10, with Jest and with Vitest, in projects written for this; each time the incremental run reused the old "Killed" and passed, and `--force` found survivors:

- an assertion weakened in a file that the spec imports (111 of 111 results reused; three survivors),
- **the gate itself changed, on another line than the mutant**: a helper in the same file that the mutated comparison goes through (10 of 12 results reused; two survivors).

So the incremental file can only be trusted when nothing at all changed. `test-gates mutation` keeps a record next to it (`reports/stryker-incremental.json.test-gates.json`) of everything the run depended on, and compares it before the next run. When something differs, or there is no record, it adds `--force` and says why:

```
test-gates mutation: running every mutant again (--force), the results of the last run are not reused: changed since the last run: src/expect-true.ts
```

What is left of incremental mode is the run after no change: a push that does not touch the subproject, a run repeated after a failure elsewhere. That one takes seconds.

What is compared:

- Every file of the subproject: gates, specs, other sources, helpers of the specs, configs, `test-gates.json`, the lock file.
- The files directly in the directories above the subproject, up to the root of the repository: the lock file and the shared configs of a monorepo.
- Packages of the same repository that are linked into `node_modules`, and directories outside the subproject that a file leads to, with a link or with a relative path (`../../pricing-kit/rounding/half-up`). When a path cannot be followed (`<rootDir>/../pricing-kit`, a way up handed to `path.join` as separate `'..'` arguments, a path to a file or a directory above the subproject), every file of the repository is compared.
- What is installed (`node_modules/.package-lock.json`, or what yarn and pnpm write in its place), the versions of Node.js, of this package, of Stryker and of the test runners, and the arguments handed to Stryker.
- The incremental file itself: it has to be the one the recorded run wrote.

With git, "every file" is what git tracks plus the untracked files it does not ignore. Without git, or when git ignores the subproject, every file is read except `node_modules`, `.git` and what the run writes itself, up to the nearest directory that has a `.git` entry, else the topmost one that declares workspaces, else only the subproject. Such a listing also contains what git would ignore (coverage output, an HTML report, logs), so a file that changes between two runs makes every run a full one; reuse is meant for a checkout with git.

The record is removed before each run and written only after a run that Stryker ended without an error and in which it wrote the incremental file, so a run that failed, was interrupted or was a dry run is followed by a full one. A run that is given `--force` is not changed. When Stryker does not run in incremental mode, nothing is recorded or compared.

The paths that leave the subproject are found by text, in every file that is compared. The search errs towards comparing too much: text that merely looks like such a path widens the comparison, and a path or a link to a directory that exists outside the repository turns reuse off, with the file named in the message.

The comparison loads the Stryker config in a process of its own, to see where the incremental file is, and reads and hashes those files before each run. Timed with a stand-in for Stryker, so that only this tool is measured, in a project of 5,200 files written for the measurement: 0.13 s without the comparison, 0.44 to 0.55 s with it (medians of three rounds; other jobs were running on the machine).

What it does not see, and what therefore still needs `-- --force` by hand, or CI, where the run should always be a full one:

- files git ignores (build output that a spec or a config loads, `.env`),
- environment variables, the clock, the network, and a Stryker config that reads them or the command line to decide about incremental mode,
- files outside the subproject that are reached without a link and without `..` in a path: an absolute path, an alias defined in a config above the subproject (in that case every file of the repository is compared only if the subproject points at that config with a relative path),
- changes inside `node_modules` that leave the files of the package manager as they were.

### `test-gates mutation-result [--report <path>]`

Judges an existing Stryker JSON report without running Stryker.

| Stryker status                      | Treated as                                                          |
| ----------------------------------- | ------------------------------------------------------------------- |
| `Killed`, `Timeout`                 | Detected                                                            |
| `Survived`, `NoCoverage`            | Survivor. Must match exactly one allowance, otherwise the run fails |
| `RuntimeError`, `CompileError`      | Not evaluable. Counted and shown, does not fail the run             |
| `Ignored`, `Pending`, anything else | Failure. A mutant that was not evaluated proves nothing             |

The run also fails when

- an allowance matches no surviving mutant of this run (stale: the mutant is now killed, or the code changed),
- an allowance matches several mutants and has no `occurrence`,
- two allowances point at the same mutant, or an allowance has no `reason`,
- a gate is missing from the report or has no mutants, or no mutant was evaluated at all,
- the report was made from a different version of a gate than the one on disk.
- a mutant timed out outside `expectedTimeouts`, or more of them than `settings.mutation.maxTimeouts` allows (see [Timeouts](#timeouts)).

`Timeout` counts as detected, but its count is always printed on its own (`detected N (timeout M)`). On a loaded machine mutants time out that would otherwise survive, so a timeout nobody has explained fails the run.

On failure every unallowed survivor is listed as `file:line:column / mutator / original → replacement / occurrence`, followed by a JSON fragment that can be pasted into `equivalentMutants`. The last line gives the real numbers, never a percentage. For the gates of this repository:

```
test-gates mutation: OK (mutants 1702 / detected 1702 (timeout 2) / allowed equivalent 0 / not evaluable 0 / unallowed survivors 0)
```

#### Timeouts

A timeout is a detection only if the mutant really cannot finish. On a loaded machine a mutant that would have survived can time out instead, and the run looks better than it is. Since 0.3.0 a timeout therefore fails the run unless the gate lists it:

```json
{
  "gates": [
    {
      "path": "src/core/args.ts",
      "decides": "…",
      "impact": "…",
      "expectedTimeouts": [
        {
          "mutator": "BlockStatement",
          "original": "{ index = consume(parsed, argv, index, allowed); }",
          "replacement": "{}",
          "reason": "With an empty body the loop index never advances, so the function never returns"
        }
      ]
    }
  ]
}
```

- `expectedTimeouts` (per gate): mutants that turn a loop into one that never ends. Same key as `equivalentMutants` (`mutator` + `original` + `replacement`, `occurrence` when ambiguous, `reason` required).
- `settings.mutation.maxTimeouts`: how many timeouts outside `expectedTimeouts` are tolerated, default `0`. Above it the run fails with exit code 1 and lists every such mutant as `file:line:column / mutator / original → replacement`, with a fragment to paste. Up to 0.2.0 the default was no limit; a project that cannot get its timeouts to zero yet sets a number here and lowers it.

How an `expectedTimeouts` entry is judged:

| The mutant is…           | Result                                              |
| ------------------------ | --------------------------------------------------- |
| `Timeout`                | Accepted, not counted against `maxTimeouts`         |
| `Killed`                 | Accepted                                            |
| `Survived`, `NoCoverage` | Failure: it is not a timeout at all, write the test |
| not in this run          | Failure: stale entry, remove it                     |

`Killed` is accepted on purpose, unlike a stale `equivalentMutants` entry. A mutant that hangs is reported as `Timeout` when Stryker's timer fires first and as `Killed` when the test runner's own per-test timeout fires first; which one wins depends on the load. Failing on `Killed` would make the list flap between two runs of the same code. And nothing is hidden by accepting it: `Killed` is the best possible outcome.

When the run fails on a timeout, first run again with less load (`npm run test:gates:mutation -- --concurrency 1`). Add an entry only for a mutant that can never finish.

`createStrykerGatesConfig` sets Stryker's `maxTestRunnerReuse` to 50 (since 0.3.2; Stryker's own default is 0, one test runner process for the whole run). A mutant that would be killed can also time out for a reason that has nothing to do with the mutant: in a Jest project with a few mutants that never end, the test runner handled about a third as many mutants per minute from the first of them on, for the rest of the run. Mutants that are killed in seconds on their own then timed out, a different set on each full run, and the run took about a quarter of an hour. With a new process every 50 mutants the speed stayed the same to the end, nothing timed out that should not, and the run took less than half as long. Why the runner slows down was not found; the restart only cuts it short. Pass `maxTestRunnerReuse` to the helper to change it.

0.3.1 set `timeoutMS` to 30000 instead. That was the wrong fix and 0.3.2 takes it back: the longer limit let most slow mutants finish, but the same full run then took about three times as long as without it, and in another project mutants that exhaust the heap crashed the test runner before the limit and came back as `RuntimeError`, which is only counted, not failed. `timeoutMS` is Stryker's default (5000) again unless the project sets it.

### `test-gates selfcheck [--all | --first | --gate <path>… | --shard <index>/<total>] [--jobs <n>] [--quick] [-- <gate command>]`

Negative control. For each gate, runs the gate with that gate's spec left out and requires the run to **fail on the coverage threshold of that very file**. A gate that stays green without its spec measures nothing; a run that fails for another reason (a config that does not load) proves nothing either.

The spec to leave out is passed in the environment variable `TEST_GATES_EXCLUDE_SPEC`. The config helpers read it. The gate command is `jest --config jest.gates.config.*` or `vitest run --config vitest.gates.config.*`, whichever config exists; override it with `settings.gateCommand` or after `--`. `--all` (default) checks every gate, `--first` only the first.

**`--quick`: one run for the gates that only their own spec touches.** A run of the gate command for every gate executes the specs of all the other gates each time, and takes minutes with many gates (see [Cost](#cost-and-how-to-use-strykers-incremental-mode)). With `--quick` and three gates or more, `selfcheck` starts with a full gate run in which the config helpers write down, for each spec file, what it executed of each gate. Leaving out the spec of a gate changes the coverage of that gate only by what its spec executed of it. So for a gate that no other spec touched, the result does not depend on which other specs are left out with it, and all those gates lose their specs in **one** run. Each of them is judged in that run as it is in a run of its own: the run has to fail, and it has to report the coverage threshold of that very file.

**It is an option, not the default, because it takes one thing for granted: that a spec executes the same code whichever other specs run with it.** A spec that covers another gate only while that gate's spec is away is not caught by any note of a full run; the run per gate catches it, because it really leaves that one spec out. Specs of pure modules do not behave that way, and the ones that could (they read `process.env`, also the variables of `selfcheck` itself, or files, a child process, the network) are recognised by their text and switch the shared run off. That is a search by text in the spec files only, not in what they import, and it cannot be made complete. Two hunts for counterexamples found projects in which `--quick` reports every control as holding and the plain run does not, with nothing in the text of a spec: a helper that keeps state in the process (it changes a setting of a Node.js core module once; with Jest that state is shared by the spec files of one worker, so whether a later spec has to do it again, and thereby executes another gate, depends on which spec ran before it, and with the default number of workers even on Jest's cache of run times), and a helper that keeps a cache on disk which one spec fills and another reads. In each of them a spec covers a gate only while that gate's spec is away. No way of taking notes from one full run can see that.

So a control that `--quick` reports as holding is not the last word; one that it reports as not holding is, because that one was run on its own. The output says so: such a line ends in `, in the shared run)`, and the last line names how many there were and asks for a run without `--quick`. **With `CI` set in the environment (to anything but an empty value, `false` or `0`), `--quick` is refused** (exit code 2): where the run is the gate itself, it has to be the full one. Most hosted CI services set `CI`; some CI systems do not set it at all, and there the job has to export `CI=true` itself, or simply not use the option.

| Where                                                   | Run                                                                                   |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| while working on one gate                               | `selfcheck --gate <path>`                                                             |
| before a push, when CI runs the gates too               | `selfcheck --quick`                                                                   |
| before a push, when that hook is the only gate there is | `selfcheck`                                                                           |
| CI                                                      | `selfcheck`, with `--shard <index>/<total>` over parallel jobs when it takes too long |

The notes are taken from what the runner itself counts for a spec file, after the file has run to its end: with Jest, the coverage a reporter is given for the file; with Vitest, what the worker hands to the istanbul coverage provider. All of it rests on the notes being complete: an execution that is missing from the note of a spec could make a gate look untouched. So the notes are used only within three limits, and outside of them every gate gets a run of its own, as before, with the reason on the first line (`test-gates selfcheck: a run of the gate command for every gate (…)`).

1. **Only for the runs it is verified with.** This table is the list; it is also `VERIFIED_RUNS` in the code, and `test/selfcheck-runners.test.ts` compares the shared run with a run per gate for every row.

   | Runner | Versions | Coverage                       | Pool                         | Other                                  |
   | ------ | -------- | ------------------------------ | ---------------------------- | -------------------------------------- |
   | Jest   | 30.5     | `babel` (what the helper sets) | —                            | one project                            |
   | Vitest | 3.2      | `istanbul`                     | `forks` (default), `threads` | `isolate: true` (default), one project |

   Another minor version, another provider or pool, spec files that share their modules, a workspace with several projects: a run per gate. The Vitest wrapper also checks what it relies on while it runs (the provider has `onAfterSuiteRun` and `initialize`; every hand-over of coverage names exactly one spec file) and reports a deviation, which has the same effect. Vitest 4.1 was tried by hand on three of the cases below and agreed; it is not in the table because the tests of this repository do not run it.

2. **Only when the notes account for what the runner counted.** The same run writes the runner's own total (its JSON coverage report). For every gate, the executions in the notes of all specs are added up and compared with that total: every function, every branch arm and every statement. An execution that happened after a note was taken, or that no note has, shows as a total above the sum; then no note is trusted. (Checked with notes taken too early, the way the first version of this took them: a cleanup function returned by `beforeAll`, and an `afterAll` with the hooks in the order written, are both refused.) Where the two cannot be compared for a gate, because the report puts the counters back onto the source through a source map and the functions do not line up, that gate gets its own run.

3. **Only on a gate run that passes.** A failing test or a gate below 100% in the full run: a run per gate.

A gate also keeps a run of its own when another spec touches it (it imports the gate, a setup file calls it, an `afterAll` or a cleanup function calls it), when its own spec is not seen to touch it, or when the shared run does not confirm it. And every gate does when

- the gate config does not use the helpers (the list of specs to leave out arrives in `TEST_GATES_EXCLUDE_SPECS` as a JSON list, the directory for the notes in `TEST_GATES_TOUCH_DIR`),
- Vitest measures with the v8 provider, which the helper cannot wrap. **v8 is the default of `createVitestGatesConfig`**: the shared run needs `coverageProvider: 'istanbul'` (see [Vitest: v8 or istanbul](#vitest-v8-or-istanbul), which recommends it for another reason),
- `settings.selfcheck.failurePattern` does not contain `{gate}`, or a gate has no single spec.

When the gate command is `jest` or `vitest` and the version installed is outside of the table, or the gate command is the one derived from the gate config and that config does not name the helper (or, for Vitest, `istanbul`), this is known beforehand and the run for the notes is not started. Otherwise that run was one run for nothing, also in every part of `--shard`.

With Jest and Vitest, and specs that do not depend on each other, the lines printed and the exit code are those of the run per gate. (A gate command of your own whose exit code says what failed would show the code of the shared run in the `✓` lines.) The two are compared with a real Jest and a real Vitest in `test/selfcheck-runners.test.ts`, for a gate that the spec of another gate covers, one that two other specs cover between them, one that another spec covers in part, one whose top-level code runs when another spec loads it, one that a setup file calls, one that another spec replaces with a mock, one that another spec calls in `afterAll` (with Vitest's hooks in the order written), and one that another spec calls in a cleanup function returned by `beforeAll`.

During the first run a directory `.test-gates-touch-…` exists in the subproject (Vitest loads the wrapped provider from there). It is removed when the run ends. A run that is interrupted leaves it behind; a later `selfcheck` removes what is older than an hour. Add `.test-gates-touch-*` to `.gitignore`.

**`--jobs <n>`: `<n>` negative controls at the same time.** The default is 1, one at a time. With `--jobs 4`, four runs of the gate command are under way at any moment, each for another gate. A control stays what it is: a run of the gate command with the spec of one gate left out, and of that one only. What `--jobs` adds is other runs on the same machine, and a run can be disturbed by them. Two things are therefore asked, one before the runs start and one of each run.

_Before the runs start_, the files a gate run loads must not be seen to reach outside of their process. A spec whose helper takes a lock on a file, listens on a fixed port or looks at the clock can quietly do less while another run is there, and then a gate that this spec covers looks as if only its own spec covered it. Nothing in the output of such a run tells. The files are: the spec of every gate, every script the gate config names (a setup file, a reporter; also in the project files the config imports), and all the project files those import, the gates among them. When one of them

- mentions `process.`, `globalThis`, `global.` or `import.meta.env`; the clock or a wait (`Date.now`, `new Date()`, `performance.now`, `setTimeout`, `setInterval`, `setImmediate`, `waitFor`, `waitUntil`, `expect.poll`, `retryTimes`, `retry:`); the network (`fetch(`, `WebSocket`, `XMLHttpRequest`); or `navigator`, `Atomics`, `WeakRef`, `FinalizationRegistry`, `eval(`, `Function(`,
- imports a built-in module of Node.js, also one that only computes (`path`): with Jest the spec files of one worker share the objects of the built-in modules, so a setting that one spec changes there is seen by the next, and which spec comes next depends on Jest's cache of run times,
- imports a package other than the runner's (`vitest`, `@jest/globals`). Packages are not looked into. With `settings.imports.mode: "allowlist"`, the packages that `settings.imports.allow` lists by name are taken too: the project already vouches for them as imports of a gate,
- loads a module whose name is computed, or imports something that is neither a file nor an installed package (an alias that `settings.importAliases` does not have),

every control runs on its own, and the first line says why:

```
test-gates selfcheck: one negative control at a time (src/support/lock.ts imports node:fs, and may meet what another run is doing)
```

The same happens when the gate command is anything but `jest` or `vitest run` with `--config` and options for the number of workers (`--runInBand`, `-i`, `--ci`, `--maxWorkers`, `-w` for Jest; `--no-file-parallelism`, `--fileParallelism=false`, `--maxWorkers`, `--minWorkers`, `--pool=forks`, `--pool=threads` for Vitest), when the gate config does not use the helper, and with `settings.selfcheck.failurePattern`. This is a search by text: a comment that names `setTimeout` counts, and `new Date('2024-01-01')` does not.

_Of each run next to others_, the result is taken only when the control held and the runner itself sums the run up as undisturbed: every spec file but the one left out passed, every test passed and none was skipped (` Test Files  13 passed (13)` and `Tests  14 passed (14)` of Vitest, `Test Suites: 13 passed, 13 total` and `Tests: 14 passed, 14 total` of Jest), every threshold the run reports is that of this gate, the process ended by itself, and no other line speaks of a failure, a timeout, an error or a retry. Anything less (a test that timed out under the load, a reporter that prints no summary) and the control is run again on its own after the others have ended, and that run counts. So a control that does **not** hold is always reported from a run of its own, with the output of that run. The first line says how many controls were run again:

```
test-gates selfcheck: 4 of 14 negative control(s) did not hold cleanly next to others and run again on their own
```

Each of the `<n>` lines of runs has a directory of its own, outside of the project, for what the coverage tool writes and for the cache of the runner. It is given on the command line (`--coverage.reportsDirectory` and `--no-cache` for Vitest, `--coverageDirectory` and `--cacheDirectory` for Jest), which wins over the gate config, and removed when the command ends. Vitest keeps the coverage of every spec file in that directory until the run ends, and empties it when a run starts: two runs in one directory read each other's files and report a gate at 0% whose spec ran. That is why a gate command with any other argument is not run at the same time; it could name such a place itself.

**Why the default stays 1.** What `--jobs` reports was compared with one control at a time in `test/selfcheck-runners.test.ts`, with a real Jest and a real Vitest (both pools), for the project described above for `--quick`: the same lines and the same exit code, TBD-STRESS. A hunt for projects in which the two differ found six, all of the same kind: a control that does not hold on its own, reported as holding with `--jobs`.

| What the project does                                                                                                | What now keeps it from being reported as holding                             |
| -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| a helper of a spec takes a lock on a file and, when another run has it, leaves out the calls that cover another gate | the helper imports `fs`: one control at a time                               |
| the same with a server on a fixed port                                                                               | the helper imports `net`: one control at a time                              |
| the same in a setup file named in the gate config                                                                    | the files the gate config names are read too                                 |
| a test skips itself when it does not get the lock (the lock is taken inside a package)                               | the summary of the run says `1 skipped`: that control runs again on its own  |
| with Jest, a test fails there, and a reporter of the project prints no failures                                      | there is no summary that says all passed: that control runs again on its own |
| with Vitest, the gate command names the coverage directory, so all runs share it                                     | a gate command with such an argument: one control at a time                  |

The first three and the last are in `test/cli.test.ts`, the other two in `test/selfcheck-runners.test.ts` with the real runners. One kind is left, and it is the reason for the default: **a package the project vouches for that reaches outside of its process after all**, and quietly. With the lock of the fourth row taken inside a package listed in `settings.imports.allow`, and the test neither skipped nor failed but simply doing less, `--jobs` still reports the control as holding. Code that hides what it uses (a property of `globalThis` is found, a name put together from strings is not) is the same kind. No search by text closes that, so `--jobs` is for projects whose specs are what the specs of pure modules usually are: calls of the gate with fixed values.

A second kind came out of a check afterwards. `--jobs` leaves out of the shared runs the specs that use the clock or timers, but it finds them by a list of names, so a spec that measures elapsed time in a way that is not on the list (`+new Date`, `AbortSignal.timeout`, `performance.mark`, or a package the project vouches for) is not seen. If which path such a spec takes depends on how long something took, the lines it covers change with the load, and a control that does not hold one at a time can be counted as holding with `--jobs`. Do the final check without `--jobs`.

**The number of workers is the gate command's.** Every run starts its own workers, and both runners take about as many as the machine has cores: `--jobs 4` is then four times that many processes. Say how many a run may take in the gate command: `"gateCommand": ["jest", "--config", "jest.gates.config.js", "--runInBand"]` (or `--maxWorkers=2`), and for Vitest `--no-file-parallelism` or `--maxWorkers=2`. `selfcheck` does not add such an option on its own: one worker per run is slower for a single run, and which is faster in sum depends on the project. TBD-SPEED

**With the other options.** `--jobs` applies to the gates that are selected: to the part of `--shard`, to the gates of `--gate`. With `--first` or a single `--gate` there is one control and nothing to run at the same time. With `--quick`, the shared run comes first and `--jobs` applies to the controls it leaves. Unlike `--quick`, `--jobs` is not refused in CI: within the limits above a control is judged from a run that left out its spec and nothing else. On machines of a hosted CI with two cores, `--shard` over parallel jobs gains more.

**A part of the gates.** Two options run only a part. A gate gets the same verdict in a part as in the whole run.

- `--shard <index>/<total>` splits the gates into `<total>` parts and checks part `<index>` (from 1). The parts are disjoint, and together they are every gate: the gates are dealt out in the order of `test-gates.json`. This is for parallel CI jobs; **every index has to run**, a single part says nothing about the gates of the others. More parts than gates is an error (exit code 2), because a part without a gate would pass without checking anything.
- `--gate <path>` checks only that gate and can be given more than once. The path is written as in `test-gates.json`; a path that is not a gate there is an error (exit code 2).

`--all`, `--first`, `--gate` and `--shard` cannot be combined, and `--shard` can be given only once. `--gate` and `--shard` win over `settings.selfcheck.mode`. Both are written before `--`: after it they would go to the gate command (Jest and Vitest have a `--shard` of their own, which would leave specs out of every run), so that is an error too (exit code 2). The last line of a run with `--gate` or `--shard` says how many gates were left out, and by what:

```
test-gates selfcheck: OK (2 negative control(s) failed as they should, 6 gate(s) not selected by --shard 1/4)
```

`--gate` is meant for a quick look while working on one gate, not as the check before a push: the negative control of a gate also changes when the spec of **another** gate starts to cover it (see the next paragraph), and that is a change in a file `--gate` was not pointed at. Run every gate in CI.

**When a gate imports another gate.** If `delivery-price.ts` imports `shipping-fee.ts` and both are gates, the spec of `delivery-price` executes every line of `shipping-fee` as well. Leaving out `shipping-fee.spec.ts` then does not lower its coverage, and `selfcheck` fails for `shipping-fee` ("the gate passed although the spec … was left out"), naming the importing gate in a hint. The coverage floor of `shipping-fee` is being held up by somebody else's spec. Fix it in the importer's spec: mock the imported gate and assert **how it is called**, so that each spec covers only its own gate:

```ts
jest.mock('./shipping-fee');
// …
expect(shippingFeeCents).toHaveBeenCalledWith(weightGrams); // called with the weight, not with the price
```

### `test-gates lcov [--file <lcov.info>]`

A line coverage floor from an lcov tracefile, without a mutation test: requires `LH == LF` for every gate in the tracefile. `--file` names the tracefile and can be left out when `settings.lcov.file` is set; with neither, the command exits with code 2. A gate without a record, or with no instrumented line, fails. Paths are compared as written in the tracefile (`lib/shipping_fee.dart`); absolute paths under the subproject are made relative.

For Dart and Flutter, use [`test_gates`](https://github.com/t09tanaka/test-gates-dart) instead. It reads the same `test-gates.json`, requires 100% of lines and of branches, has a negative control and judges a mutation test. The example below shows what this command alone does with a Dart package.

```bash
flutter test --coverage && npx test-gates lcov --file coverage/lcov.info
```

Settings for a Dart package that uses only `lcov`:

```json
{
  "gates": [{ "path": "lib/shipping_fee.dart", "decides": "…", "impact": "…" }],
  "candidates": [],
  "settings": {
    "gateExtensions": [".dart"],
    "spec": { "suffixes": [] },
    "lcov": { "file": "coverage/lcov.info", "summaryExclude": ["\\.g\\.dart$", "lib/l10n/"] }
  }
}
```

Do not run `test-gates check` on such a manifest: Dart annotations such as `@JsonSerializable()` look like decorators to it.

Lines are counted from the `DA:` entries, not taken from `LH:` / `LF:`. A tracefile whose `LH:` was edited but whose `DA:` lines still show an unexecuted line fails; `LH:` / `LF:` are only used for a record that has no `DA:` entry at all.

## Allowing an equivalent mutant

An equivalent mutant changes the code without changing anything observable: same return value, same exception, same side effects, for every input. Only those may be allowed, in `test-gates.json`, with the reason.

An example. A gate limits a fee to a maximum:

```ts
let fee = Math.ceil(weightGrams / 1000) * 500;
if (fee > MAX_FEE_CENTS) {
  fee = MAX_FEE_CENTS;
}
return fee;
```

The specs check every boundary, and one mutant still survives:

```
test-gates mutation: 1 surviving mutant(s) not in the allow list
  - src/shipping-fee.ts:9:7 / EqualityOperator / fee > MAX_FEE_CENTS → fee >= MAX_FEE_CENTS (Survived)

Fix the test so that it detects the mutant. Only when the mutant cannot be observed from
outside (same return value, exception and side effects for every input), add it to
"equivalentMutants" of the gate in test-gates.json and fill in "reason":

  src/shipping-fee.ts
    {"mutator":"EqualityOperator","original":"fee > MAX_FEE_CENTS","replacement":"fee >= MAX_FEE_CENTS","reason":""}

test-gates mutation: FAILED (mutants 14 / detected 13 (timeout 0) / allowed equivalent 0 / not evaluable 0 / unallowed survivors 1)
```

With `>=` the only input that is treated differently is a fee equal to the maximum, and that fee is set to the value it already has. No test can tell the two apart, so the gate lists the mutant:

```json
{
  "path": "src/shipping-fee.ts",
  "decides": "The fee for sending a parcel, by weight, and its maximum",
  "impact": "A heavy parcel is sent for too little, or the customer pays more than the advertised maximum",
  "equivalentMutants": [
    {
      "mutator": "EqualityOperator",
      "original": "fee > MAX_FEE_CENTS",
      "replacement": "fee >= MAX_FEE_CENTS",
      "reason": "A fee that is equal to the maximum is set to the maximum, which is the value it has"
    }
  ]
}
```

- The key is `mutator` + `original` + `replacement`. `original` is the source text at the location Stryker reports (taken from the report's copy of the source). Whitespace differences are ignored. **Line numbers are not part of the key**, so moving code does not break an allowance, and an allowance never covers a different mutant on the same line.
- When the same key occurs more than once in a file, `occurrence` (1-based, in source order) is required.
- An error message or a label is not equivalent just because no test reads it. If it matters, assert it (`toThrow(/…/)`).
- If in doubt, write the test.

Expected values in the tests come from the specification, not from the implementation's own constants: a test that loops over the constant it is checking cannot notice that the constant is wrong.

## Settings

All optional. Patterns are regular expressions written as JSON strings; a rule is either a string or `{ "pattern", "flags", "reason" }`. An unknown key is an error (exit code 2), so a typo cannot silently fall back to a default.

| Setting                        | Default                                                      | Purpose                                                                                                                                              |
| ------------------------------ | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gateExtensions`               | `.ts .mts .cts .js .mjs .cjs`                                | Extensions a gate may have                                                                                                                           |
| `spec.suffixes`                | `.spec<ext>` and `.test<ext>` of the gate                    | Replaces the gate's extension to form the spec path. Exactly one must exist. `[]` means no spec convention (spec checks are skipped)                 |
| `spec.rewrite`                 | none                                                         | `[{ "from", "to" }]` applied to the gate path first, for specs in another directory (`^app/` → `tests/`)                                             |
| `impureImports.defaults`       | `true`                                                       | Built-in list, see below                                                                                                                             |
| `impureImports.add`            | none                                                         | More module patterns a gate must not import at runtime                                                                                               |
| `impureImports.allow`          | none                                                         | Module patterns exempt from every rule (e.g. `^express$` where `express` is imported only for its types without `import type`)                       |
| `impureNamedImports`           | `PrismaClient` from `@prisma/client`                         | `{ "defaults", "add": [{ "module", "names", "reason" }] }`: names banned from a module that is otherwise fine                                        |
| `impurePaths`                  | `.vue` `.jsx` `.tsx`, `.d.ts`                                | `{ "defaults", "add" }`: gate paths that are rejected (`\\.service\\.ts$`, `^src/hooks/`)                                                            |
| `forbiddenSource`              | `'use client'` / `'use server'`, `process.env` (0.3.0)       | `{ "defaults", "add" }`: lines that must not appear in a gate, tested one line at a time                                                             |
| `importAliases`                | none                                                         | `[{ "prefix": "@/", "target": "src/" }]`, to recognise `jest.mock('@/x')` of the module under test                                                   |
| `gateCommand`                  | derived from `jest.gates.config.*` / `vitest.gates.config.*` | Command `selfcheck` runs, as an array (`["jest", "--config", "jest.gates.config.js", "--maxWorkers=2"]`)                                             |
| `selfcheck.mode`               | `all`                                                        | `all` or `first`                                                                                                                                     |
| `selfcheck.failurePattern`     | a threshold message on a line naming the gate                | Regular expression the failing run's output must match; `{gate}` stands for the gate path                                                            |
| `stryker.configFile`           | `stryker.gates.config.mjs` (`.js`, `.cjs`, `.json`)          | Stryker config                                                                                                                                       |
| `stryker.reportFile`           | `reports/mutation/mutation.json`                             | Where the JSON report is written (by the helper) and read (by the judge)                                                                             |
| `lcov.file`                    | none                                                         | Tracefile for `test-gates lcov` when `--file` is not given                                                                                           |
| `lcov.summaryExclude`          | none                                                         | Paths left out of the reference total (`\\.g\\.dart$`)                                                                                               |
| `imports.mode` (0.2.0)         | `blocklist`                                                  | `allowlist` turns the import check around, see [Allowlist mode](#allowlist-mode)                                                                     |
| `imports.allow` (0.2.0)        | none                                                         | Packages a gate may import in allowlist mode: `"decimal.js"`, `{ "pattern": "^@acme/pure-" }`, `{ "module": "@prisma/client", "names": ["Prisma"] }` |
| `mutation.maxTimeouts` (0.2.0) | `0` (0.3.0; no limit before)                                 | Timeouts tolerated outside `expectedTimeouts`, see [Timeouts](#timeouts)                                                                             |

Built-in impure imports: `@nestjs/*`, `class-validator`, `class-transformer`, `typeorm`, `sequelize`, `mongoose`, `knex`, `pg`, `mysql`, `mysql2`, `ioredis`, `redis`, `@prisma/adapter-*`, `react`, `react-dom`, `next`, `server-only`, `client-only`, `vue`, `vue-router`, `vue-i18n`, `pinia`, `nuxt`, `#app`, `#imports`, `*.vue`, `express`, `express-jwt`, `fastify`, `koa`, `rxjs`, `passport`, `passport-*`, `axios`, `openapi-fetch`, `stripe`, `nodemailer`, `firebase-admin`, `@aws-sdk/*`, `@sentry/*`, `@slack/*`, `@stripe/*`, and the Node.js modules `fs`, `http`, `https`, `http2`, `net`, `tls`, `dgram`, `dns`, `child_process`, `worker_threads`.

`@prisma/client` itself is allowed: `Prisma.Decimal` and enums are values a pure module may use. Only `PrismaClient` is banned.

Project-specific layers go into `add`:

```json
{
  "settings": {
    "spec": { "suffixes": [".spec.ts"] },
    "importAliases": [{ "prefix": "@/", "target": "src/" }],
    "impureImports": {
      "add": [
        {
          "pattern": "(^|/)(persistence|gateways)(/|$)",
          "reason": "talks to the database or to a remote API"
        },
        { "pattern": "\\.(service|controller)$", "reason": "class created by the DI container" }
      ]
    },
    "impurePaths": {
      "add": [
        {
          "pattern": "\\.(service|controller|module)\\.ts$",
          "reason": "a class with decorators"
        }
      ]
    }
  }
}
```

### Allowlist mode

The default import check is a blocklist: it knows the frameworks and SDKs listed above, and a new SDK passes until somebody adds it. `settings.imports.mode: "allowlist"` (since 0.2.0) turns it around. A gate may then import at runtime only

- relative paths and paths through `importAliases` (the project's own files),
- what `settings.imports.allow` lists,
- anything with `import type` (types leave no trace at runtime).

Everything else is a violation, including Node.js built-ins (`fs` and `node:fs` alike; list `node:path` if a gate needs it) and a `require()` / `import()` whose argument is not a string literal.

```json
{
  "settings": {
    "importAliases": [{ "prefix": "@/", "target": "src/" }],
    "imports": {
      "mode": "allowlist",
      "allow": ["decimal.js", "date-fns", { "module": "@prisma/client", "names": ["Prisma"] }]
    }
  }
}
```

- A string is a package name and covers its subpaths (`date-fns`, `date-fns/locale`).
- `{ "pattern" }` is a regular expression tested against the whole specifier.
- `{ "module", "names" }` allows only those names, and only as named imports. `import { Prisma } from '@prisma/client'` passes; `import { PrismaClient }`, a default import, `import * as` and `require()` do not.

The blocklist stays in force underneath. A project file is not safe just because it is relative: `./user.service` is still rejected by an `impureImports` pattern, and in allowlist mode also when the file it points at matches `impurePaths` (a service, a component). `impureImports.allow` (exempt a module from the blocklist) and `imports.allow` (the list of permitted packages) are different settings.

What it does not do: follow the imports. Only the gate's own import statements are read. If `./rates` is allowed and `rates.ts` itself imports a database client, that is not noticed unless `rates.ts` is a gate too. A transitive check would need real module resolution (extensionless imports, `index` files, `paths` of tsconfig, package `exports`), and a resolver that guesses wrong reports violations that are not there. It was left out for that reason; register the imported file as a gate when it matters.

A manifest that uses `settings.imports` or `settings.mutation` needs 0.2.0 or later: 0.1.0 rejects unknown settings.

## Config helpers

```ts
import { createJestGatesConfig } from '@t09tanaka/test-gates/jest';
import { createVitestGatesConfig } from '@t09tanaka/test-gates/vitest';
import { createStrykerGatesConfig } from '@t09tanaka/test-gates/stryker';
import { loadGates } from '@t09tanaka/test-gates';
```

Each helper is available as ES module and CommonJS. `rootDir` is the directory of `test-gates.json`: `__dirname`, or `import.meta.url` of the config file. Every other option is passed through, except the keys that make the run a gate. Those are always set by the helper and cannot be overridden:

| Helper                     | Always set                                                                                                                                                                                                        |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createJestGatesConfig`    | `testMatch` (specs of the gates), `collectCoverage`, `collectCoverageFrom` (the gates), `coverageProvider: 'babel'`, `coverageThreshold` (one absolute-path key per gate, four metrics at 100), `passWithNoTests` |
| `createVitestGatesConfig`  | `root`, `test.include`, `test.passWithNoTests`, `test.coverage.enabled`, `test.coverage.include`, `test.coverage.thresholds: { perFile: true, 100 × 4 }`                                                          |
| `createStrykerGatesConfig` | `mutate` (the gates), `thresholds.break: null`, `json` among the `reporters`, `jsonReporter.fileName`. Throws on `ignoreStatic`, `ignorers`, `mutator.excludedMutations`                                          |

Why these choices:

- Jest measures with istanbul (`babel`), because the v8 provider does not count the untaken side of an `if` without `else`.
- Jest fails on a `coverageThreshold` path key that matches no file, so a typo in `test-gates.json` cannot pass. Vitest does the opposite: a glob or path key in `thresholds` that matches nothing passes. The Vitest helper therefore narrows `coverage.include` to the gates and uses `perFile`.
- Stryker never fails on its own score (`break: null`). The verdict comes from `test-gates mutation`, which knows the allow list.
- The Stryker helper also sets defaults that can be overridden: `coverageAnalysis: 'perTest'`, `incremental` with its file under `reports/` (reused by `test-gates mutation` only after no change, see [When the results of the last run are reused](#when-the-results-of-the-last-run-are-reused)), and `maxTestRunnerReuse: 50` (see [Timeouts](#timeouts)).

`loadGates(dir)` returns the validated manifest: `gates` (each with its resolved `spec`), `candidates` and the resolved `settings`. It throws when the manifest has any problem.

## Vitest: v8 or istanbul

The Jest helper forces istanbul. The Vitest helper defaults to `v8`, and whether that is as strict depends on the Vitest version. Measured with one module per construct and a test that takes only one side; "found" means branches were reported below 100%:

| Only one side tested                         | Vitest 3.2.7 v8 | 3.2.7 v8 + `experimentalAstAwareRemapping` | 3.2.7 istanbul | Vitest 4.1.11 v8 | 4.1.11 istanbul |
| -------------------------------------------- | --------------- | ------------------------------------------ | -------------- | ---------------- | --------------- |
| `if (a) { … }` without `else`, never skipped | **missed**      | found                                      | found          | found            | found           |
| `if (!a) return …` (early return)            | found           | found                                      | found          | found            | found           |
| `a ? x : y`                                  | found           | found                                      | found          | found            | found           |
| `a ?? b`                                     | found           | found                                      | found          | found            | found           |
| `a && f()` with `a` always false             | found           | found                                      | found          | found            | found           |
| default parameter `(a = 3)`, always passed   | **missed**      | **missed**                                 | found          | **missed**       | found           |
| `o?.y` with `o` always undefined             | found           | not a branch                               | not a branch   | not a branch     | not a branch    |

So the asymmetry is real on Vitest 3: with the default v8 provider a gate can show 100% branches while the skipped side of an `if` was never tested. Vitest 4 closes that gap; an unused default parameter is still only seen by istanbul. The mutation test catches both cases anyway (a mutant in untested code survives), but the floor should not have a hole in it.

Recommended: istanbul for the gate run.

```bash
npm install -D @vitest/coverage-istanbul   # same major version as vitest
```

```ts
export default defineConfig(
  createVitestGatesConfig({ rootDir: import.meta.url, coverageProvider: 'istanbul' })
);
```

The helper's default stays `v8` because changing it would break every project that has only `@vitest/coverage-v8` installed. Instead `test-gates check` fails (since 0.3.0; a warning in 0.2.0) when it finds a `vitest.gates.config.*`, an installed Vitest below 4, and neither `istanbul` nor `experimentalAstAwareRemapping: true` in that config. On Vitest 4 the v8 provider passes the check.

## Cost, and how to use Stryker's incremental mode

Mutation testing is the expensive step. Numbers for this repository's own gates:

| Run                                               | Machine                                              | Time       |
| ------------------------------------------------- | ---------------------------------------------------- | ---------- |
| 6 gates, about 1,000 lines, 809 mutants, full run | an outside evaluator's machine (not specified)       | 4 min 24 s |
| the same 6 gates, 809 mutants, full run           | Apple M2 Max (12 cores), Node 22.22, `concurrency 2` | 41 s       |
| 8 gates, 1,136 lines, 1,021 mutants, full run     | same machine, other jobs running                     | 1 min 19 s |
| the same, incremental, nothing changed            | same machine                                         | 8–15 s     |

The time grows with the number of mutants and depends heavily on cores and on `concurrency`. Twenty gates of this size on a slow machine are well past ten minutes for a full run. The setup that has held up in practice:

- **pre-push: incremental.** `test-gates mutation` as is. Stryker's incremental file (`reports/stryker-incremental.json`, not committed) makes a run after no change take seconds; the first run after a clone is a full one, and so is every run after a change in the subproject or in what it depends on (see [When the results of the last run are reused](#when-the-results-of-the-last-run-are-reused)).
- **CI: full.** `npm run test:gates:mutation -- --force`. CI has no incremental file to start from anyway, and the full run is the one that counts.
- If even CI is too slow, split by subproject (each has its own `test-gates.json`) before you think about sampling.

The negative control (`selfcheck`) is the step that grows fastest: a run of the gate command per gate, each executing the specs of all the other gates, grows up to the square of the number of gates. With `--quick` it uses one run for the gates that only their own spec touches (see [`selfcheck`](#commands) for what that takes for granted). Measured on a project written for this measurement: N gates of 20 lines each, one spec of five tests per gate, Vitest 3.2 with istanbul or Jest 30 with ts-jest, Stryker 10 without a `concurrency` setting; an Apple M2 Max (12 cores), Node 22.22, other jobs running. Read the growth, not the seconds:

| Gates | Runner | Gate run | `selfcheck` | `selfcheck --quick` | `mutation -- --force` |
| ----- | ------ | -------- | ----------- | ------------------- | --------------------- |
| 5     | Vitest | 0.9 s    | 3.8 s       | 1.3 s               | 13 s                  |
| 30    | Vitest | 2.0 s    | 49 s        | 2.1 s               | 38 s                  |
| 100   | Vitest | 5.1 s    | 8 min 4 s   | 5.0 s               | 1 min 55 s            |
| 5     | Jest   | 0.8 s    | 6.3 s       | 1.4 s               | 8 s                   |
| 30    | Jest   | 2.4 s    | 1 min 19 s  | 3.1 s               | 22 s                  |
| 100   | Jest   | 3.1 s    | 6 min 2 s   | 4.5 s               | 1 min 8 s             |

In this project no spec touches the gate of another, so `selfcheck --quick` is two runs of the gate command. (That column was measured later, with fewer other jobs running than for the other columns; the difference in load is far smaller than the difference between the two columns.) Every gate that another spec touches adds a run of its own. For the plain `selfcheck`, which is the one for CI, `--shard <index>/<total>` splits the runs over parallel jobs: each part runs its share of the gates. That does not reduce the total work; only the waiting time gets shorter.

How the incremental file and this tool interact (covered by `test/incremental.test.ts`, which runs a real Stryker):

- `test-gates mutation` deletes the JSON **report** before each run. It does not touch the incremental file; they are different files. It decides whether Stryker may read it: see [When the results of the last run are reused](#when-the-results-of-the-last-run-are-reused).
- A run in which every result is reused still writes a complete JSON report, and the verdict is the same as that of the run it reuses.
- **After removing a gate, its old results stay in the incremental file** and come back in the report. They are ignored: only the gates of `test-gates.json` are judged. (A change of `test-gates.json` makes the next run a full one, and the old results still come back.) Delete the incremental file when you change the list of gates, so that it does not carry files that are no longer mutated.

## Limitations and things measured

- **A file with decorators cannot reach 100% branches under Jest.** The type metadata emitted for decorators contains inline conditionals (`typeof X === "undefined" ? Object : X`) that no test can take both ways. That is why decorated files are rejected as gates instead of being given a lower threshold.
- **Stryker does not mutate everything.** A constant property reference such as `Decimal.ROUND_UP` is left alone. Guard the rounding direction with an explicit test.
- **Stryker 10 does not start on Node.js 22.10** (`ERR_REQUIRE_ESM`). It runs on 22.14 and 22.22. On Node.js below 22.12 use Stryker 9.
- **Do not call the gate while the spec file is being collected** (in the body of `describe`, or at module level). The mutants reached that way become _static_ mutants, and with Stryker 10 and Vitest 3 a spec file that throws during collection was reported as `Survived`, not `Killed`. Call the gate inside `it` / `beforeEach`.
- **Jest treats an empty `testMatch` as its default pattern** and would run every test of the project. The helpers never produce an empty list; if you write the gate config by hand, do not either.
- **`process.env` is found by text too.** A comment that mentions it is reported, and reading the environment through another name (`const { env } = process`) is not. The clock (`Date.now()`, `new Date()`) and `Math.random()` are not checked: a default argument such as `now = new Date()` is a legitimate way to pass them in, and text cannot tell it from a direct read. Add a `forbiddenSource` rule if the project wants one.
- **Imports are found by text, not by parsing.** The checks run without the project's dependencies installed, so an import inside a comment is reported too, and only the gate's own imports are looked at, not what those modules import in turn.
- **An ordinary `import { Request } from 'express'` used only as a type is reported.** Write `import type`, or exempt the module with `impureImports.allow`.
- **`test-gates lcov` checks lines only.** It does not read the branch entries (`BRDA:`) of a tracefile and runs no mutation test, so a gate that only this command checks is guarded by line coverage alone. Dart and Flutter code is guarded by [`test_gates`](https://github.com/t09tanaka/test-gates-dart), which checks lines and branches and judges a mutation test.
- **knip reports the Stryker runner as unused** once no npm script calls `stryker run` directly. Tell knip where the config is: `"stryker": { "config": ["stryker.gates.config.mjs"] }` in `knip.json`.
- **A directory or worktree whose name contains `test-`** (for example a checkout called `test-gates-migration`) makes `@darraghor/eslint-plugin-nestjs-typed` treat every file as a test file, because it matches the whole path against a test pattern. Not caused by this package, but a name like that is easy to choose while adopting it.
- **A comment line that starts with `@t09tanaka/…`** in a config file can be read by ESLint's JSDoc rules as a tag. Put the package name in the middle of the sentence.
- **Vitest 4's `text` reporter can print only the summary line** and no per-file table for the gate run. The thresholds and the negative control still work.
- **The checks do not judge what belongs in `gates`.** Whether every important decision has been extracted and registered is for people to review; `candidates` is where the known gaps are written down.

## Related tools

- [test_gates](https://github.com/t09tanaka/test-gates-dart) (pub.dev): the same gates for Dart and Flutter.
- [dart_mutant](https://github.com/t09tanaka/dart_mutant): mutation testing for Dart, the tool that writes the mutation report those gates judge.
- [contract-fixtures](https://github.com/t09tanaka/contract-fixtures) (TypeScript and Dart): shared request and response fixtures that keep an API and its clients in step.

## Contributing

Run `npm run check:quick` (lint, typecheck, format check and the light tests; about 20 seconds) before you push. CI runs the same checks as a separate fast job, and the heavy tests, gates and mutation test as parallel jobs.

## License

MIT
