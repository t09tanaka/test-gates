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

On failure every unallowed survivor is listed as `file:line:column / mutator / original → replacement / occurrence`, followed by a JSON fragment that can be pasted into `equivalentMutants`. The last line gives the real numbers, never a percentage:

```
test-gates mutation: OK (mutants 317 / detected 308 (timeout 0) / allowed equivalent 8 / not evaluable 1 / unallowed survivors 0)
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

### `test-gates selfcheck [--all | --first] [-- <gate command>]`

Negative control. For each gate, runs the gate with that gate's spec left out and requires the run to **fail on the coverage threshold of that very file**. A gate that stays green without its spec measures nothing; a run that fails for another reason (a config that does not load) proves nothing either.

The spec to leave out is passed in the environment variable `TEST_GATES_EXCLUDE_SPEC`. The config helpers read it. The gate command is `jest --config jest.gates.config.*` or `vitest run --config vitest.gates.config.*`, whichever config exists; override it with `settings.gateCommand` or after `--`. `--all` (default) checks every gate in turn, `--first` only the first.

**When a gate imports another gate.** If `api-key-auth.ts` imports `safe-compare.ts` and both are gates, the spec of `api-key-auth` executes every line of `safe-compare` as well. Leaving out `safe-compare.spec.ts` then does not lower its coverage, and `selfcheck` fails for `safe-compare` ("the gate passed although the spec … was left out"), naming the importing gate in a hint. The coverage floor of `safe-compare` is being held up by somebody else's spec. Fix it in the importer's spec: mock the imported gate and assert **how it is called**, so that each spec covers only its own gate:

```ts
jest.mock('./safe-compare');
// …
expect(safeCompare).toHaveBeenCalledWith(presentedKey, storedKey); // right arguments, right order
```

### `test-gates lcov --file <lcov.info>`

For stacks without mutation testing (Flutter / Dart): requires `LH == LF` for every gate in an lcov tracefile. A gate without a record, or with no instrumented line, fails. Paths are compared as written in the tracefile (`lib/models/coupon.dart`); absolute paths under the subproject are made relative.

```bash
flutter test --coverage && npx test-gates lcov --file coverage/lcov.info
```

Settings for a Dart package that uses only `lcov`:

```json
{
  "gates": [{ "path": "lib/models/coupon.dart", "decides": "…", "impact": "…" }],
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

- **pre-push: incremental.** `test-gates mutation` as is. Stryker's incremental file (`reports/stryker-incremental.json`, not committed) makes the second and later runs take seconds; the first run after a clone is a full one.
- **CI: full.** `npm run test:gates:mutation -- --force`. CI has no incremental file to start from anyway, and the full run is the one that counts.
- If even CI is too slow, split by subproject (each has its own `test-gates.json`) before you think about sampling.

How the incremental file and this tool interact (covered by `test/incremental.test.ts`, which runs a real Stryker):

- `test-gates mutation` deletes the JSON **report** before each run. It does not touch the incremental file; they are different files.
- A run in which every result is reused still writes a complete JSON report, and the verdict is the same as that of the run it reuses.
- **A stale "Survived" can be reused.** After adding a test that kills a _static_ mutant (code that runs when the module is loaded, such as a module-level constant), the incremental run kept reporting the mutant as survived; `--force` reported it killed. The error is on the safe side, a failure that is not real, never a pass that is not real. When a survivor makes no sense after you fixed the test, run once with `-- --force`.
- **After removing a gate, its old results stay in the incremental file** and come back in the report. They are ignored: only the gates of `test-gates.json` are judged. Delete the incremental file (or run with `--force`) when you change the list of gates, so that it does not carry files that are no longer mutated.

## Limitations and things measured

- **A file with decorators cannot reach 100% branches under Jest.** The type metadata emitted for decorators contains inline conditionals (`typeof X === "undefined" ? Object : X`) that no test can take both ways. That is why decorated files are rejected as gates instead of being given a lower threshold.
- **Stryker does not mutate everything.** A constant property reference such as `Decimal.ROUND_UP` is left alone. Guard the rounding direction with an explicit test.
- **Stryker 10 does not start on Node.js 22.10** (`ERR_REQUIRE_ESM`). It runs on 22.14 and 22.22. On Node.js below 22.12 use Stryker 9.
- **Do not call the gate while the spec file is being collected** (in the body of `describe`, or at module level). The mutants reached that way become _static_ mutants, and with Stryker 10 and Vitest 3 a spec file that throws during collection was reported as `Survived`, not `Killed`. Call the gate inside `it` / `beforeEach`.
- **Jest treats an empty `testMatch` as its default pattern** and would run every test of the project. The helpers never produce an empty list; if you write the gate config by hand, do not either.
- **`process.env` is found by text too.** A comment that mentions it is reported, and reading the environment through another name (`const { env } = process`) is not. The clock (`Date.now()`, `new Date()`) and `Math.random()` are not checked: a default argument such as `now = new Date()` is a legitimate way to pass them in, and text cannot tell it from a direct read. Add a `forbiddenSource` rule if the project wants one.
- **Imports are found by text, not by parsing.** The checks run without the project's dependencies installed, so an import inside a comment is reported too, and only the gate's own imports are looked at, not what those modules import in turn.
- **An ordinary `import { Request } from 'express'` used only as a type is reported.** Write `import type`, or exempt the module with `impureImports.allow`.
- **`test-gates lcov` checks lines only.** lcov from Flutter carries no branch data, and Dart has no established mutation testing tool; a Dart gate is guarded by coverage alone.
- **knip reports the Stryker runner as unused** once no npm script calls `stryker run` directly. Tell knip where the config is: `"stryker": { "config": ["stryker.gates.config.mjs"] }` in `knip.json`.
- **A directory or worktree whose name contains `test-`** (for example a checkout called `test-gates-migration`) makes `@darraghor/eslint-plugin-nestjs-typed` treat every file as a test file, because it matches the whole path against a test pattern. Not caused by this package, but a name like that is easy to choose while adopting it.
- **A comment line that starts with `@t09tanaka/…`** in a config file can be read by ESLint's JSDoc rules as a tag. Put the package name in the middle of the sentence.
- **Vitest 4's `text` reporter can print only the summary line** and no per-file table for the gate run. The thresholds and the negative control still work.
- **The checks do not judge what belongs in `gates`.** Whether every important decision has been extracted and registered is for people to review; `candidates` is where the known gaps are written down.

## License

MIT
