import { describe, expect, it } from 'vitest';
import { diagnose, type DoctorFacts, formatFindings } from './doctor';

const healthy: DoctorFacts = {
  incremental: true,
  failure: null,
  widened: [],
  scope: { files: 12 },
  hooks: [{ file: '.husky/pre-push', affected: true }],
};

describe('diagnose', () => {
  it('finds nothing in a subproject whose runs can be reused', () => {
    expect(diagnose(healthy)).toEqual([]);
  });

  it('says only that incremental mode is off when it is', () => {
    expect(diagnose({ ...healthy, incremental: false, failure: 'x', hooks: [] })).toEqual([
      {
        level: 'problem',
        text: 'Stryker does not run in incremental mode: every run is one of every mutant',
        fix: 'make the Stryker config with createStrykerGatesConfig, or set incremental: true',
      },
    ]);
  });

  it('names a listing that fails', () => {
    expect(diagnose({ ...healthy, failure: 'src/a.ts points outside' })).toEqual([
      {
        level: 'problem',
        text: 'the results of a run are never reused: src/a.ts points outside',
        fix: 'remove the path, or let it lead into the repository. A path that leads outside of it to nothing is compared as missing',
      },
    ]);
  });

  it('names the paths that made every file of the repository part of the comparison', () => {
    expect(diagnose({ ...healthy, widened: ['pkg/eslint.config.js "../"', 'pkg/x.ts'] })).toEqual([
      {
        level: 'problem',
        text: 'every file of the repository is compared, so a change anywhere in it makes the next run a full one. Because of: pkg/eslint.config.js "../"; pkg/x.ts',
        fix: 'write such a path from the directory of its file (path.resolve(__dirname, …)) so that it can be followed, or keep it out of the files the run loads',
      },
    ]);
  });

  it('notes that every file is followed, with a fix when the runner config is not the helper', () => {
    expect(
      diagnose({
        ...healthy,
        scope: { every: 'the runner config is not made with createJestGatesConfig' },
      })
    ).toEqual([
      {
        level: 'note',
        text: 'the paths in every file of the subproject are followed, also in files the run does not load: the runner config is not made with createJestGatesConfig',
        fix: 'make the runner config with createJestGatesConfig or createVitestGatesConfig',
      },
    ]);
    expect(diagnose({ ...healthy, scope: { every: 'src/a.ts imports x' } })).toEqual([
      {
        level: 'note',
        text: 'the paths in every file of the subproject are followed, also in files the run does not load: src/a.ts imports x',
        fix: null,
      },
    ]);
    expect(diagnose({ ...healthy, scope: null })).toEqual([]);
  });

  it('notes a subproject that no hook runs, and names each hook without --affected', () => {
    expect(diagnose({ ...healthy, hooks: [] })).toEqual([
      {
        level: 'note',
        text: 'no git hook runs test-gates mutation for this subproject',
        fix: null,
      },
    ]);
    expect(
      diagnose({
        ...healthy,
        hooks: [
          { file: '.husky/pre-push', affected: false },
          { file: 'lefthook.yml', affected: true },
        ],
      })
    ).toEqual([
      {
        level: 'problem',
        text: '.husky/pre-push runs test-gates mutation without --affected: a change of any file of the subproject runs every mutant',
        fix: 'pass --affected in the hook (npm run test:gates:mutation -- --affected); keep the run in CI without it',
      },
    ]);
  });
});

describe('formatFindings', () => {
  it('says OK and exits 0 without a problem, also with notes', () => {
    expect(formatFindings([])).toEqual({ lines: ['test-gates doctor: OK'], status: 0 });
    expect(formatFindings([{ level: 'note', text: 'n', fix: null }])).toEqual({
      lines: ['note: n', 'test-gates doctor: OK'],
      status: 0,
    });
  });

  it('counts the problems and exits 1, with each fix below its finding', () => {
    expect(
      formatFindings([
        { level: 'problem', text: 'a', fix: 'do x' },
        { level: 'note', text: 'b', fix: 'do y' },
        { level: 'problem', text: 'c', fix: null },
      ])
    ).toEqual({
      lines: [
        'problem: a',
        '  fix: do x',
        'note: b',
        '  fix: do y',
        'problem: c',
        'test-gates doctor: 2 problem(s) that make runs full ones',
      ],
      status: 1,
    });
  });
});
