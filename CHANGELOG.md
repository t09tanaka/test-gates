# Changelog

## 0.3.2

### Changed

- `createStrykerGatesConfig` sets Stryker's `maxTestRunnerReuse` to 50 unless the project passes its own (Stryker's default is 0: one test runner process for the whole run). In a project with mutants that never end, the runner became about three times slower from the first of them on, and mutants that are killed in seconds on their own timed out. Starting a new process every 50 mutants kept the speed: a full run of 781 mutants went from 14 to 18 minutes with stray timeouts to under 7 minutes with none.
- `timeoutMS` is no longer set by the helper; Stryker's default (5000) applies again. The 30000 of 0.3.1 was the wrong fix. It rested on the idea that a restarted runner makes the next mutant slow, when in fact a runner that is not restarted stays slow. With 30000 the same full run took 47 minutes and still failed, and mutants that exhaust the heap crashed the runner and were reported as `RuntimeError` instead of `Timeout`.

A project that set `timeoutMS` itself to work around stray timeouts can remove it.

## 0.3.1

### Changed

- `createStrykerGatesConfig` sets Stryker's `timeoutMS` to 30000 unless the project passes its own (Stryker's default is 5000). With `maxTimeouts` at 0 since 0.3.0, a mutant that would be killed but ran out of time fails the run. That happened on every full run in two projects with mutants that really never end: after each of them Stryker starts a new test runner, and the next mutant timed out while it was starting. A full run takes longer by up to 25 seconds for each mutant that hangs without tripping Stryker's loop counter.

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
- README: when the package is worth using, timeouts, allowlist mode, the Vitest v8 / istanbul measurements, cost and incremental mode, settings for Dart, and notes from migrating six repositories.

### Changed

- The package's own gates now run with the allowlist, `maxTimeouts: 0` and istanbul, and include the two new decision modules (8 gates).

## 0.1.0

First release: `test-gates check`, `mutation`, `mutation-result`, `selfcheck`, `lcov`; config helpers for Jest, Vitest and Stryker; JSON Schema for `test-gates.json`.
