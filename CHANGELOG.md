# Changelog

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
