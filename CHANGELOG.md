# Changelog

## Unreleased

### Changed

- `test-gates mutation` compares fewer files outside the subproject before it reuses the results of the last run, so that a change elsewhere in a repository no longer turns every run into a full one:
  - A path that leads up from a file and back into the subproject (`'../helper'` from `src/` to a file at the top of the subproject) no longer makes every file of the repository part of the comparison. It was taken for a path to a directory above the subproject.
  - A path that starts at the directory of its own file is followed: `` `${__dirname}/../shared` ``, and `__dirname, '..', 'shared'` handed to `path.join` or `path.resolve` (also with `import.meta.dirname`). Before, every file of the repository was compared. When such a path ends in a directory above the subproject, only the files directly in it are compared, as they always are; when an unknown part follows it (`join(__dirname, '..', name)`), every file still is.
  - Paths in `.md`, `.markdown`, `.txt`, `.rst` and `.adoc` files are no longer followed. The files themselves are still compared.
  - A plain relative path to a file or a directory above the subproject (`'../tsconfig.base.json'`), a path whose start is not known, and `'..'` after anything but the directory of the file still make every file of the repository part of the comparison.
- When a path leads outside of the repository and the results are therefore not reused, the message names the path as it is written, next to the file it is in.

## 0.3.4

One change of behaviour: `test-gates mutation` no longer lets Stryker reuse old results after a change. The rest is new options of `selfcheck`; without them it runs as before.

### Changed

- `test-gates mutation` lets Stryker reuse the results of the last run only when nothing the run depends on has changed since. Stryker's incremental mode reuses the result of a mutant when the text at its place and a test that killed it are the same; a change on another line of the gate, or in a file the spec imports, could turn a killed mutant into a survivor and the old "Killed" was reused. A record next to the incremental file (`reports/stryker-incremental.json.test-gates.json`) now holds a hash of every file of the subproject and of what it leads to, the versions of the tools and the arguments for Stryker. When anything differs, or there is no record, the run gets `--force` and the first line says why. The first run after the update is therefore one of every mutant. A run after no change is reused as before. See "When the results of the last run are reused" in the README for what is compared and what is not seen.
- `test-gates mutation` takes `--gate` for itself. Before, it was handed to Stryker like every unknown argument (Stryker has no such option).
- `test-gates check`, `lcov` and the config helpers read each directory once while they look for the gates and their specs, instead of once for every gate and every place its spec may be in. What they report is unchanged.

### Added

- `test-gates selfcheck --gate <path>` (may be given more than once) and `--shard <index>/<total>` run the negative control of a part of the gates: one gate while working on it, or one of several parts for parallel CI jobs. The last line says how many gates were not selected. More parts than gates, a path that is not a gate, and either option after `--` are errors (exit code 2).
- `test-gates selfcheck --quick` uses one run of the gate command for all the gates that only their own spec touches, as far as a full gate run with the config helpers shows it (Jest 30.5; Vitest 3.2 with the istanbul provider). It is for work in progress and not the final check: it takes for granted that a spec executes the same code whichever other specs run with it. Controls judged in the shared run are marked in the output, the last line asks for a run without the option, and the option is refused when `CI` is set (exit code 2).
- README: Dart and Flutter projects are pointed to the package for Dart; `lcov --file` is shown as optional.
- `test-gates mutation --gate <path>` runs and judges the mutants of the named gates only, for the time a gate is being worked on. It is not the final check: a change in one gate can make a mutant of another gate survive. The last line says so, the run takes nothing over from an earlier one and leaves neither a record nor a JSON report behind, and the option is refused when `CI` is set.
- `test-gates selfcheck --jobs <n>` runs `<n>` negative controls at the same time. The default stays 1. A control is taken from a run next to others only when the runner sums that run up as undisturbed (every other spec file passed, every test passed, none skipped, no threshold but that of its gate, no line that speaks of a failure); any other control is run again on its own, and that run counts, so a control that does not hold is always reported from a run of its own. The controls are started at the same time only when the gate command is `jest` or `vitest run` with `--config` and options for the number of workers, the gate config uses the helper, and no file a gate run loads (specs, scripts the gate config names, and the project files those import) is seen to use the environment, the clock, the network, a built-in module of Node.js or a package the project does not vouch for; otherwise the first line says why and the run is one control at a time. Each line of runs writes its coverage and the cache of the runner to a directory of its own outside of the project. See the README for what the search by text cannot see, which is why it is an option.

## 0.3.3

Documentation only; the commands and the helpers behave as in 0.3.2.

- The paths and outputs shown in the README are those of a small example written for it and of this repository's own gates.

## 0.3.2

### Changed

- `createStrykerGatesConfig` sets Stryker's `maxTestRunnerReuse` to 50 unless the project passes its own (Stryker's default is 0: one test runner process for the whole run). In a project with mutants that never end, the runner became about three times slower from the first of them on, and mutants that are killed in seconds on their own timed out. Starting a new process every 50 mutants kept the speed: a full run of about 800 mutants went from about a quarter of an hour with stray timeouts to less than half of that with none.
- `timeoutMS` is no longer set by the helper; Stryker's default (5000) applies again. The 30000 of 0.3.1 was the wrong fix. It rested on the idea that a restarted runner makes the next mutant slow, when in fact a runner that is not restarted stays slow. With 30000 the same full run took about three times as long and still failed, and mutants that exhaust the heap crashed the runner and were reported as `RuntimeError` instead of `Timeout`.

A project that set `timeoutMS` itself to work around stray timeouts can remove it.

## 0.3.1

### Changed

- `createStrykerGatesConfig` sets Stryker's `timeoutMS` to 30000 unless the project passes its own (Stryker's default is 5000). With `maxTimeouts` at 0 since 0.3.0, a mutant that would be killed but ran out of time fails the run. That happened on every full run in projects with mutants that really never end: after each of them Stryker starts a new test runner, and the next mutant timed out while it was starting. A full run takes longer by up to 25 seconds for each mutant that hangs without tripping Stryker's loop counter.

## 0.3.0

Three defaults move to the strict side. A project that passed with 0.2.0 can fail with 0.3.0 without any change of its own; each case below says what to do.

### Changed (breaking)

- `settings.mutation.maxTimeouts` defaults to `0` (was: no limit). A mutant that times out outside `expectedTimeouts` now fails `test-gates mutation`. Run again with less load (`-- --concurrency 1`) first. For a mutant that can never finish, add it to `expectedTimeouts` of the gate with the reason. To tolerate some for now, set `settings.mutation.maxTimeouts` to a number.
- `test-gates check` fails, instead of warning, when the gate run uses Vitest below 4 with the v8 provider and neither `istanbul` nor `experimentalAstAwareRemapping: true`. Use `createVitestGatesConfig({ coverageProvider: 'istanbul' })` (needs `@vitest/coverage-istanbul`), or move to Vitest 4.
- A gate that reads `process.env` fails `test-gates check` (new built-in `forbiddenSource` rule). Take the value as an argument and read the environment in the caller. `settings.forbiddenSource.defaults: false` turns the built-in rules off, including the `'use client'` / `'use server'` one.

### Removed

- The `warning:` line of `test-gates check`. Nothing is reported as a warning any more.

## 0.2.0

Everything added here is opt-in. With an unchanged `test-gates.json` and unchanged config files, 0.2.0 gives the same verdicts, exit codes and summary line as 0.1.0. The one visible difference is a warning on stderr from `test-gates check` for Vitest 3 with the v8 provider (see below); it does not change the exit code.

A manifest that uses the new settings needs 0.2.0 or later, because 0.1.0 rejects unknown settings.

### Added

- `settings.mutation.maxTimeouts`: fail the mutation run when more mutants time out than this. Not set means no limit, as before.
- `expectedTimeouts` per gate: mutants that can never finish (a loop that no longer ends), matched like `equivalentMutants`. They are not counted against `maxTimeouts`. An entry whose mutant survives or does not exist fails the run; one that is killed is accepted.
- `settings.imports.mode: "allowlist"` with `settings.imports.allow`: a gate may import at runtime only relative paths, import aliases, listed packages (optionally only listed names, e.g. `Prisma` from `@prisma/client`) and types. The default stays `blocklist`.
- `createVitestGatesConfig({ coverageProvider: 'istanbul' })`, and `@vitest/coverage-istanbul` as an optional peer dependency.
- `test-gates check` warns when the gate run uses Vitest below 4 with the v8 provider, which does not count the skipped side of an `if` without `else`.
- `test-gates selfcheck` names the gates that import a gate whose spec could be left out without the gate failing.
- CI for this repository (lint, tests, gates, negative control, full mutation run; build and tests on Node 20).
- README: when the package is worth using, timeouts, allowlist mode, the Vitest v8 / istanbul measurements, cost and incremental mode, settings for Dart, and notes from adopting it in several repositories.

### Changed

- The package's own gates now run with the allowlist, `maxTimeouts: 0` and istanbul, and include the two new decision modules (8 gates).

## 0.1.0

First release: `test-gates check`, `mutation`, `mutation-result`, `selfcheck`, `lcov`; config helpers for Jest, Vitest and Stryker; JSON Schema for `test-gates.json`.
