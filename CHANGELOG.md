# Changelog

## 0.4.3

This release spares more full runs of `test-gates mutation`: `--affected` keeps telling the gates apart where only some of them read files, a new linked worktree starts from the record of the main worktree, and timeouts on a loaded machine are run again before they fail the run. Three things to know when updating:

- The record of a run has a new format (3: it says for each gate whether it is blind), and a record of an older format is not read. So the first run after the update is one of every mutant.
- A new linked worktree that has no record of its own starts from the incremental file and the record of the main worktree. Every file that differs from the main worktree counts as changed.
- Before it starts Stryker, `test-gates mutation` removes the sandboxes an interrupted run left in the subproject. A Stryker started by hand has no marker of a run, so if one runs in the same subproject at the same time, its sandbox is removed.

### Added

- A new linked worktree (`git worktree add`) that has neither an incremental file nor a record starts from those of the main worktree, at the same path. The incremental file is copied into place, and the record goes through the usual comparison, so a file that differs here (another branch, a change) counts as changed. The files of the main worktree are never written. The first line of the run says so, and `test-gates doctor` says beforehand whether the next run starts from the main worktree. Nothing is taken over with `--gate` or `--force`, or inside a Stryker sandbox. A blind gate (see below) never takes its results over from the main worktree, since a file git ignores, such as an `.env`, is not compared and differs between worktrees as a rule: with `--affected` it is run again, and without `--affected` the run is one of every mutant.
- `test-gates mutation` runs again, once and one at a time (`--mutate` with their ranges, `--concurrency 1`, `--force`), the mutants that timed out outside `expectedTimeouts` when there are more of them than `settings.mutation.maxTimeouts` allows. Their new result takes the place of the timeout before the report is judged: killed is killed, a survivor fails the run, and a timeout again fails as before. In incremental mode the next run takes over the new result. If the run again fails or writes no report, the first run is judged, and the output says so. This is done in CI too. `mutation-result` runs nothing again.
- `test-gates mutation` removes the sandboxes (`<tempDirName>/sandbox-*`) that an interrupted Stryker run left in the subproject, before it starts Stryker. Tools that walk the subproject no longer find a second copy of every file. `backup-*` of `inPlace` is never removed. Nothing is removed when the temp directory is outside the subproject, when `cleanTempDir` is `false`, or while another `test-gates mutation` runs there: each run keeps a marker with its pid and the start time of its process while Stryker runs. `test-gates doctor` notes the sandboxes that are left, and whether the next run removes them.

### Changed

- `mutation --affected` runs again only the gates that cannot be told apart. A file that reads files no import names (`readFileSync`, `readFile`, a glob, jsdom `fromFile` / `fromURL`, a path from `__dirname` handed to a reading function or to a package such as `dotenv`) now makes only the gates that depend on it blind. A blind gate runs again after a change of any compared file and keeps its results when nothing changed; the other gates are still told apart. What may load modules that are not followed still runs every gate. `test-gates doctor` names the blind gates in a note.
- `mutation --affected` takes a `.html` or `.htm` file for a document, as the comparison does since 0.4.2, so a page that no gate depends on (the HTML report of Stryker, a page of the docs) no longer runs every mutant. `index.html` and `index.htm` still do, since Vite starts from one. To keep this safe:
  - a path from the top of the subproject to a `.html`, `.htm`, `.md` or `.json` file, written as text (`'src/page.html'`), is now a file of the one that names it;
  - `readFile` and jsdom `fromFile` / `fromURL` count as reading files, as `readFileSync` does;
  - the query of a Vite import (`?raw`, `?url`, `?inline`, `?worker`) is cut off before the file is looked up, so `import page from './page.html?raw'` leads to `page.html`.
- `test-gates doctor` reads `case "$var" in` and `for var in a b; do … done` in a hook. A hook that loops over the subprojects and gives `--affected` to some of them only is no longer reported as running every subproject without it. A pattern that may stand for other names (`*`, `app*`, `{a,b}`) still stands for any subproject, and a hook that cannot be read this way is read as before.
- `selfcheck --jobs` shares the cores between the runs at the same time: each one gets `--maxWorkers=max(1, floor(cores / runs))` of Jest or Vitest. Nothing is added when the gate command or the config of the runner already sets the workers. `--jobs 1` is unchanged.
- `selfcheck --jobs` no longer takes the text of a string in quotes (`'retry: {count}'` in a file of messages) for a use that keeps a gate out of the runs at the same time. Template literals, and strings that hold `${`, still count.

### Fixed

- `selfcheck --jobs` reported "N of N negative control(s) did not hold cleanly next to others", and ran every control on its own, when another `selfcheck --jobs` on the same machine removed its temporary directory at the wrong moment. The tidying of old directories now passes over an entry it cannot look at. When no directory for the runs can be made, the output now says so. The same fix applies to the shared run of `--quick`.

## 0.4.2

Most of this release closes cases where `test-gates mutation` took over the results of the last run although a file the run depends on had changed, with `--affected` and without it. The rest spares full runs that were not needed. Two things to know when updating: the first run after it is one of every mutant, since the record holds the version of test-gates; and in a project whose runner config maps modules in a way that `settings.importAliases` does not name, `--affected` no longer tells the gates apart until the aliases are added (`test-gates doctor` names them).

### Fixed

These made a run take over results that a change could have turned into survivors.

- `mutation --affected` kept the results of a gate after a change of a file it depends on:
  - An import put together from strings (`import('./locales/' + lang + '.ts')`, `require('./rules/' + lang)`) was not followed at all. Any `require()` / `import()` whose argument is not one string literal is now one whose path is not written out, and what the gates depend on is unknown. Allowlist mode of `test-gates check` now rejects such an import too.
  - With `x.ts` and `x.js` next to each other, `./x` was taken for `x.ts` alone while the runner may load `x.js`. Every script that exists for a path is now followed (also by the comparison and by `selfcheck --jobs`).
  - Module maps of the runner (`resolve.alias` / `test.alias` of Vite, `moduleNameMapper` of Jest, also in package.json, `jsc.paths` of `.swcrc`, tsconfig `paths` for Vitest, Babel `module-resolver`) can send an import somewhere else than the path says. Such a map now makes what the gates depend on unknown, unless it does what an alias of `settings.importAliases` does, is a `moduleNameMapper` entry to one fixed module (a style stub), or is a `paths` entry of one name that leads to an installed package. The reason names every such map and the alias to add; `test-gates doctor` shows it in its note.
  - Where the run drops imports of types, a spec with `import type { Rate } from './rate'` and `jest.createMockFromModule<Rate>('./rate')` left `./rate` out of what the gate loads. `createMockFromModule` and `genMockFromModule` are now followed, also with a type argument.
- `test-gates mutation` (without `--affected` too) reused the results after a change in files the comparison did not reach:
  - A directory whose name holds glob characters (`shared/[rates]`, a `[locale]` of Next.js) was listed as empty by git and dropped out of the comparison. The path handed to git is now escaped.
  - A plain `..` path that exists only from the subproject, where the run starts (`readFileSync('../shared-data/x.json')` in a spec, `path.resolve('../…')` in a setup file), was resolved from the directory of the file only. It is now resolved from the subproject as well. One from the subproject that lies outside of what can be listed is refused, and one that ends in a directory holding the repository makes every file of the repository part of the comparison.
  - A file git ignores that the run loads (generated code, downloaded fixtures a spec imports) was not compared. With the helper's runner config it is now hashed and its paths followed.
  - `patches/` of patch-package, in the subproject and in the directories above it, is compared.
  - The node on PATH, which the shebang of `node_modules/.bin/stryker` starts, is recorded as `Node.js on PATH`; a change of it runs every mutant.
  - A path in a file above the subproject that the comparison reaches (`"extends": "./configs/strict.json"` in a base tsconfig at the top of the repository) is followed by the same rules as a path in the subproject.

### Changed

These spare full runs, or runs of more gates, that were not needed.

- `mutation --affected` gives up telling the gates apart in fewer cases:
  - An import of a module that only has a declaration file (`@/types/schema` for `src/types/schema.d.ts`, `index.d.ts` of a directory) leads to that file. A script of the same name still comes first.
  - An import of types only (`import type`, `export type … from`, an import whose names are all marked `type`) is left out of what a gate depends on, but only where the run is known not to check types: no checkers in the Stryker config, and Vitest without `typecheck`, or Jest with ts-jest and `isolatedModules: true` or `diagnostics: false`, or with `@swc/jest`, `babel-jest`, `esbuild-jest` or `@sucrase/jest` and neither ts-jest nor a preset. `import { type A } from './a'` is left out only where no compiler config keeps imports as written (`verbatimModuleSyntax`, `preserveValueImports`, `importsNotUsedAsValues`, `onlyRemoveTypeImports`). Anything else keeps the import.
  - A file other than a script that a runner config names (`coverage.exclude: ['src/components/Foo.vue']`, a JSON stub of `moduleNameMapper`) is taken as a config by itself: a change of it runs every gate again, but a component named there no longer makes `--affected` refuse.
  - A file that uses `__dirname`, `__filename` or `import.meta.url` / `dirname` / `filename` only to find where it lies keeps the gates apart. It is refused only when it may also read by that path: a call that reads or looks at a file or a directory, a mock named by a computed path, a `Worker`, or an import of a package or built-in module other than `path`, `url`, `vitest` and `@jest/globals`.
  - `require('./rates')` of `rates.json` leads to the JSON file (also `<dir>/index.json`), after the scripts, as Node, Jest and Vite do.
  - An import or a word such as `readFileSync` in a comment no longer counts. A relative path in quotes is still followed wherever it is written.
  - A mock in a `__mocks__` next to a module (`src/__mocks__/dep.ts`) is loaded with that module, so a change of it runs again only the gates that load the module. The `__mocks__` at the top of the subproject, and a mock named as an installed package or a built-in module, are still configs.
- A run without `--affected` writes what each gate depends on too, whenever it writes a record. Before, the next `--affected` run after a run without it, or after `-- --force`, had nothing to go on and ran every mutant. Runs with `--gate` and runs that fail still write none.
- A mutant that timed out in the last run and that an `expectedTimeouts` entry of its gate points at is taken over, with and without `--affected`. Before, such mutants that never end were run again on every run. Any other timeout is still run again.
- A plain path to a file directly in a directory above the subproject (`"extends": "../../tsconfig.base.json"`) no longer makes every file of the repository part of the comparison: that file is compared anyway. A path to a directory above, or to a missing file there, still does.
- The files of Stryker's reporters (`htmlReporter`, `jsonReporter`, or their defaults) and the files that `ignorePatterns` leaves out (`.eslintcache`, `tsconfig.tsbuildinfo`) are no longer taken for files the run reads. A new report or cache no longer runs every mutant, and the paths in an HTML report no longer make every file of the repository part of the comparison. Where a pattern of `ignorePatterns` starts with `!`, nothing is left out by it. The paths in `.html` files are not followed.
- `test-gates check` keeps a `..` of an import that leaves the subproject (`resolveSpecifier`): `../../shared/x` from `src/a.ts` is `../shared/x`, not `shared/x`. An import outside is judged by the path it points at, a mock of a module outside is no longer taken for a mock of the gate, and `selfcheck` no longer lists a file that imports a module outside as an importer of a gate of the same path inside. A root-anchored `impurePaths` rule (`^shared/`) no longer matches an import outside.
- The comparison and the work of `--affected` before a run are faster: the files of each path are looked up once in a run (on this repository the snapshot went from about 140 to 90 ms).

## 0.4.1

### Fixed

- `test-gates mutation --affected` reuses every result after no change also where it cannot tell what a gate depends on (a file a gate or a spec loads reads files at run time, for one). Before, such a subproject ran every mutant on every run with the option, while a run without it reused the results after no change. The first line says so; a change still runs every mutant.
- `test-gates doctor` reports what keeps `--affected` from telling the gates apart: as a problem when a hook relies on `--affected`, else as a note. In such a subproject it no longer asks for `--affected` in a hook. Before, it said OK although a run with `--affected` was always one of every mutant.

## 0.4.0

Most of this release is about runs that were full ones although little had changed. `test-gates doctor` tells why a project's runs are full ones. `mutation --affected` runs again only the gates a change can affect. The comparison before a run covers only what the run loads. Two changes of behaviour: Stryker's `concurrency` now defaults to half of the cores, and the record of a run has a new format, so the first run after the update is one of every mutant.

### Added

- `test-gates doctor` tells why `test-gates mutation` would run every mutant where it need not, and what to change: Stryker not in incremental mode, a path that turns reuse off, the file and the path that make every file of the repository part of the comparison, and a git hook that runs mutation without `--affected`. It also shows how many files are compared, whether the next run reuses the last one, and what a run with `--affected` would run again. It runs nothing and changes nothing; the exit code is 1 when there is a problem.
- `test-gates mutation --affected` runs again only the gates that a change since the last run can affect, and keeps the results of the others. The unit is the gate: every mutant of a gate that may have changed is run again, and Stryker's judgement per mutant is not relied on. A gate depends on itself, its own spec, every spec that imports it or whose tests covered or killed one of its mutants, and what all of those import. A change of a config, a lock file, a tool or the arguments, a file whose imports cannot be followed or that reads files at run time, a run with `--force`, and a run in CI (`CI` set) run every mutant, and the first line says why; otherwise the first lines say how many gates were reused and which file made each of the others run again. A package of the same repository linked into `node_modules` also runs every mutant: its files are not followed. A component (`.vue`, `.svelte`, `.astro`, `.mdx`) that a gate or a spec loads runs every mutant as well: it can use others that it does not import. A gate with an unallowed survivor or timeout always runs again. A mutant that timed out in the last run is run again on its own (`--mutate` with its range), also in a reused gate, since a timeout on a loaded machine can stand for a survivor. It is an option: without it a change of any compared file still runs every mutant. See "`--affected`" in the README.

### Changed

- `createStrykerGatesConfig` sets `concurrency` when the options do not: half of the cores (`os.availableParallelism()`), at least 1 and at most 8, and 2 when `CI` is set. Stryker's own default was one fewer than the cores. A `concurrency` in the options wins, and `--concurrency` on Stryker's command line wins over both. See "How many test runners Stryker starts" in the README.
- `test-gates selfcheck --jobs <n>` decides for each control whether it runs next to others. Before, one file anywhere in the gate run that reached outside of its process (the clock, the environment, a built-in module, a package not vouched for) made every control run one at a time. Now only the control of a gate is kept apart that a spec of another gate loads while that spec, or a file it loads, reaches outside, or that a spec may load because its imports cannot all be followed; a file the gate config names that reaches outside still keeps every control apart. The controls kept apart run one at a time after the others, and the first lines name every one of them with every reason, instead of the first reason only. A spec that reaches outside but loads only its own gate keeps nothing apart. The other checks (the gate command, the gate config, `failurePattern`, and the judgement of each run next to others) are unchanged, and the default stays 1.
- `test-gates mutation` no longer takes over a timeout from the last run after no change: the mutants that timed out are run again on their own, the other results are reused as before.
- In a git hook of a linked worktree (`GIT_DIR` set, `GIT_WORK_TREE` not), `test-gates mutation` lists the files from the top of the repository. Before, git took the subproject for it, a path to a sibling directory led "outside of the repository", and every run was a full one.
- The record next to the incremental file is of a new format (2), with what a run with `--affected` writes down about each gate. The first run after the update is one of every mutant.
- `test-gates mutation` compares fewer files outside the subproject before it reuses the results of the last run, so that a change elsewhere in a repository no longer turns every run into a full one:
  - A path that leads up from a file and back into the subproject (`'../helper'` from `src/` to a file at the top of the subproject) no longer makes every file of the repository part of the comparison. It was taken for a path to a directory above the subproject.
  - A path that starts at the directory of its own file is followed: `` `${__dirname}/../shared` ``, and `__dirname, '..', 'shared'` handed to `path.join` or `path.resolve` (also with `import.meta.dirname`). Before, every file of the repository was compared. When such a path ends in a directory above the subproject, only the files directly in it are compared, as they always are; when an unknown part follows it (`join(__dirname, '..', name)`, or something added to what the call returns), every file still is. A way up after a placeholder (`` `../x/${name}/../..` ``) now also makes every file part of the comparison; before, only the part before the placeholder was followed.
  - Paths in `.md`, `.markdown`, `.txt`, `.rst` and `.adoc` files are no longer followed. The files themselves are still compared.
  - A plain relative path to a file or a directory above the subproject (`'../tsconfig.base.json'`), a path whose start is not known, and `'..'` after anything but the directory of the file still make every file of the repository part of the comparison.
- In a project where the comparison is now smaller, the first run after the update is one of every mutant: the record of the last run holds files that are no longer compared, and the message lists them as changed.
- When a path leads outside of the repository and the results are therefore not reused, the message names the path as it is written, next to the file it is in.
- With a runner config made by `createJestGatesConfig` or `createVitestGatesConfig`, `test-gates mutation` follows the paths only in the files of the subproject that the run loads: the configs and the files they name, the gates, their specs, the configs that the tools read by name (`tsconfig*.json`, Babel, SWC), mocks, and everything those import. The other files, `package.json` among them, are still compared, but a `'../'` in a lint config, a script in `package.json`, `$PROJECT_DIR$/..` in the settings of an editor or `<rootDir>/../shared` in the config of another test run no longer makes every file of the repository part of the comparison. An alias that `settings.importAliases` does not name loads the files of the subproject whose paths end as the import does. A loaded file that imports a module whose path is not written out, and a runner config made otherwise, keep the search in every file.
- A path that leads outside of the repository to nothing (one meant for the sandbox of Stryker, such as `path.resolve(__dirname, '../../../shared')` in a runner config) is compared as missing, instead of turning reuse off. Once something is there, reuse is off as before.

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
