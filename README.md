# test-gates

[![CI](https://github.com/t09tanaka/test-gates/actions/workflows/ci.yml/badge.svg)](https://github.com/t09tanaka/test-gates/actions/workflows/ci.yml)

Test gates for the code that must not be wrong.

This package guards the handful of modules where a wrong decision costs money or trust: amounts and rounding, state transitions of payments and orders, authentication and role checks, expiry and remaining-quota rules.

- **100% coverage is only the floor.** It proves that a test exists and touches every branch. It does not prove that the test checks the decision.
- **Mutation testing is the real check.** If the code can be changed without a test failing, the decision is not guarded. Every surviving mutant must be killed by a test, or allowed one by one with a written reason.
- **Important decisions live in pure modules, and pure modules are registered.** No decorators, no DI, no database, no framework runtime. The list of registered modules is one file: `test-gates.json`.

`test-gates` is a CLI plus three small config helpers. It has no runtime dependencies. Jest, Vitest and Stryker are the ones already installed in your project.

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
      "path": "src/common/utils/money.ts",
      "decides": "Validation and rounding of amounts",
      "impact": "Wrong invoice and refund amounts"
    }
  ],
  "candidates": [
    {
      "path": "src/admin/guards/admin-role.guard.ts",
      "decides": "Who is an administrator",
      "blocker": "Has decorators. The decision has to be extracted into a pure module"
    }
  ]
}
```

- `gates`: pure modules that hold an important decision. Each one needs a spec next to it (`money.spec.ts` or `money.test.ts`), 100% on statements, branches, functions and lines, and no surviving mutant outside its allow list.
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

Add `reports/` and `.stryker-tmp/` to `.gitignore`.

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

## Commands

All commands take `--dir <subproject>` (default: the current directory).

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
- A gate and its spec have no coverage ignore directive (`istanbul ignore`, `c8 ignore`, `v8 ignore`).
- A spec has no `.skip`, `.only`, `.todo`, `xit`, `xdescribe`, `fit`, `fdescribe`, `.skipIf`, `.runIf`, `.fails`.
- A spec does not `jest.mock` / `vi.mock` the module it is supposed to test.
- A gate has no `Stryker disable` / `Stryker restore` comment. Such a comment turns off a whole line for a whole mutator, which takes non-equivalent mutants out with it.
- `equivalentMutants` entries are well formed and each has a `reason`.
- The Stryker config does not use `excludedMutations`, `ignoreStatic` or `ignorers`.

### `test-gates mutation [-- <stryker arguments>]`

Runs `stryker run <config>` from the project's own `node_modules`, then judges the JSON report (see `mutation-result`). Unknown arguments, and everything after `--`, are handed to Stryker. If Stryker itself fails, the exit code is 1 and nothing is judged. A report from an earlier run is deleted first, so a run that writes none cannot pass on old results.

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

`Timeout` counts as detected, but its count is always printed on its own (`detected N (timeout M)`). On a loaded machine mutants time out that would otherwise survive, so a rising timeout count means the run may be hiding survivors: rerun with lower `--concurrency`.

On failure every unallowed survivor is listed as `file:line:column / mutator / original → replacement / occurrence`, followed by a JSON fragment that can be pasted into `equivalentMutants`. The last line gives the real numbers, never a percentage:

```
test-gates mutation: OK (mutants 317 / detected 308 (timeout 0) / allowed equivalent 8 / not evaluable 1 / unallowed survivors 0)
```

### `test-gates selfcheck [--all | --first] [-- <gate command>]`

Negative control. For each gate, runs the gate with that gate's spec left out and requires the run to **fail on the coverage threshold of that very file**. A gate that stays green without its spec measures nothing; a run that fails for another reason (a config that does not load) proves nothing either.

The spec to leave out is passed in the environment variable `TEST_GATES_EXCLUDE_SPEC`. The config helpers read it. The gate command is `jest --config jest.gates.config.*` or `vitest run --config vitest.gates.config.*`, whichever config exists; override it with `settings.gateCommand` or after `--`. `--all` (default) checks every gate in turn, `--first` only the first.

### `test-gates lcov --file <lcov.info>`

For stacks without mutation testing (Flutter / Dart): requires `LH == LF` for every gate in an lcov tracefile. A gate without a record, or with no instrumented line, fails. Paths are compared as written in the tracefile (`lib/models/coupon.dart`); absolute paths under the subproject are made relative.

```bash
flutter test --coverage && npx test-gates lcov --file coverage/lcov.info
```

## Allowing an equivalent mutant

An equivalent mutant changes the code without changing anything observable: same return value, same exception, same side effects, for every input. Only those may be allowed, in `test-gates.json`, with the reason:

```json
{
  "path": "src/lib/auth/safe-compare.ts",
  "decides": "Constant-time comparison of tokens",
  "impact": "Token comparison leaks timing or accepts a wrong token",
  "equivalentMutants": [
    {
      "mutator": "ConditionalExpression",
      "original": "a.length !== b.length",
      "replacement": "false",
      "reason": "timingSafeEqual below throws on a length mismatch and the catch returns false, so the result is the same"
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

| Setting                    | Default                                                      | Purpose                                                                                                                              |
| -------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `gateExtensions`           | `.ts .mts .cts .js .mjs .cjs`                                | Extensions a gate may have                                                                                                           |
| `spec.suffixes`            | `.spec<ext>` and `.test<ext>` of the gate                    | Replaces the gate's extension to form the spec path. Exactly one must exist. `[]` means no spec convention (spec checks are skipped) |
| `spec.rewrite`             | none                                                         | `[{ "from", "to" }]` applied to the gate path first, for specs in another directory (`^app/` → `tests/`)                             |
| `impureImports.defaults`   | `true`                                                       | Built-in list, see below                                                                                                             |
| `impureImports.add`        | none                                                         | More module patterns a gate must not import at runtime                                                                               |
| `impureImports.allow`      | none                                                         | Module patterns exempt from every rule (e.g. `^express$` where `express` is imported only for its types without `import type`)       |
| `impureNamedImports`       | `PrismaClient` from `@prisma/client`                         | `{ "defaults", "add": [{ "module", "names", "reason" }] }`: names banned from a module that is otherwise fine                        |
| `impurePaths`              | `.vue` `.jsx` `.tsx`, `.d.ts`                                | `{ "defaults", "add" }`: gate paths that are rejected (`\\.service\\.ts$`, `^src/hooks/`)                                            |
| `forbiddenSource`          | `'use client'` / `'use server'`                              | `{ "defaults", "add" }`: lines that must not appear in a gate, tested one line at a time                                             |
| `importAliases`            | none                                                         | `[{ "prefix": "@/", "target": "src/" }]`, to recognise `jest.mock('@/x')` of the module under test                                   |
| `gateCommand`              | derived from `jest.gates.config.*` / `vitest.gates.config.*` | Command `selfcheck` runs, as an array (`["jest", "--config", "jest.gates.config.js", "--maxWorkers=2"]`)                             |
| `selfcheck.mode`           | `all`                                                        | `all` or `first`                                                                                                                     |
| `selfcheck.failurePattern` | a threshold message on a line naming the gate                | Regular expression the failing run's output must match; `{gate}` stands for the gate path                                            |
| `stryker.configFile`       | `stryker.gates.config.mjs` (`.js`, `.cjs`, `.json`)          | Stryker config                                                                                                                       |
| `stryker.reportFile`       | `reports/mutation/mutation.json`                             | Where the JSON report is written (by the helper) and read (by the judge)                                                             |
| `lcov.file`                | none                                                         | Tracefile for `test-gates lcov` when `--file` is not given                                                                           |
| `lcov.summaryExclude`      | none                                                         | Paths left out of the reference total (`\\.g\\.dart$`)                                                                               |

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
          "pattern": "(^|/)(repository|wrapper|handler)(/|$)",
          "reason": "DB / external API layer"
        },
        { "pattern": "\\.(service|guard|controller|module)$", "reason": "class managed by DI" }
      ]
    },
    "impurePaths": {
      "add": [
        {
          "pattern": "\\.(service|guard|controller|module|dto)\\.ts$",
          "reason": "NestJS class file"
        }
      ]
    }
  }
}
```

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

`loadGates(dir)` returns the validated manifest: `gates` (each with its resolved `spec`), `candidates` and the resolved `settings`. It throws when the manifest has any problem.

## Limitations and things measured

- **A file with decorators cannot reach 100% branches under Jest.** The type metadata emitted for decorators contains inline conditionals (`typeof X === "undefined" ? Object : X`) that no test can take both ways. That is why decorated files are rejected as gates instead of being given a lower threshold.
- **Stryker does not mutate everything.** A constant property reference such as `Decimal.ROUND_UP` is left alone. Guard the rounding direction with an explicit test.
- **Stryker 10 does not start on Node.js 22.10** (`ERR_REQUIRE_ESM`). It runs on 22.14 and 22.22. On Node.js below 22.12 use Stryker 9.
- **Do not call the gate while the spec file is being collected** (in the body of `describe`, or at module level). The mutants reached that way become _static_ mutants, and with Stryker 10 and Vitest 3 a spec file that throws during collection was reported as `Survived`, not `Killed`. Call the gate inside `it` / `beforeEach`.
- **Jest treats an empty `testMatch` as its default pattern** and would run every test of the project. The helpers never produce an empty list; if you write the gate config by hand, do not either.
- **Imports are found by text, not by parsing.** The checks run without the project's dependencies installed, so an import inside a comment is reported too, and only the gate's own imports are looked at, not what those modules import in turn.
- **An ordinary `import { Request } from 'express'` used only as a type is reported.** Write `import type`, or exempt the module with `impureImports.allow`.
- **`test-gates lcov` checks lines only.** lcov from Flutter carries no branch data, and Dart has no established mutation testing tool; a Dart gate is guarded by coverage alone.
- **The checks do not judge what belongs in `gates`.** Whether every important decision has been extracted and registered is for people to review; `candidates` is where the known gaps are written down.

## License

MIT
