import { describe, expect, it } from 'vitest';
import { diagnose, type DoctorFacts, formatFindings, hookUses } from './doctor';

const healthy: DoctorFacts = {
  incremental: true,
  forced: false,
  failure: null,
  widened: [],
  scope: { files: 12 },
  hooks: [{ file: '.husky/pre-push', affected: true }],
  blind: null,
  blindGates: [],
  gates: 3,
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

  it('names what keeps --affected from telling the gates apart, as a note without a hook that relies on it', () => {
    const plain = [{ file: '.husky/pre-push', affected: false }];
    expect(diagnose({ ...healthy, hooks: plain, blind: 'src/db.ts uses readdirSync' })).toEqual([
      {
        level: 'note',
        text: 'with --affected, a change of any file runs every mutant: what a gate depends on cannot be told (src/db.ts uses readdirSync)',
        fix: 'keep what reads files or loads modules by a computed name out of what the gates and their specs import, or run without --affected',
      },
    ]);
    const mixed = [...plain, { file: 'lefthook.yml', affected: true }];
    expect(
      diagnose({ ...healthy, hooks: mixed, blind: 'src/db.ts uses readdirSync' })[0]?.level
    ).toBe('problem');
    expect(diagnose({ ...healthy, blind: 'src/db.ts uses readdirSync' })).toEqual([
      {
        level: 'problem',
        text: 'with --affected, a change of any file runs every mutant: what a gate depends on cannot be told (src/db.ts uses readdirSync)',
        fix: 'keep what reads files or loads modules by a computed name out of what the gates and their specs import, or run without --affected',
      },
    ]);
  });

  it('names the gates that --affected runs again for any change, as a note, and still asks for --affected', () => {
    const blindGates = [
      { gate: 'src/a.ts', reason: 'src/env.ts uses readFileSync' },
      { gate: 'src/b.ts', reason: 'src/env.ts uses readFileSync' },
    ];
    expect(diagnose({ ...healthy, blindGates })).toEqual([
      {
        level: 'note',
        text: 'with --affected, a change of any file runs 2 of 3 gate(s) again (src/a.ts, src/b.ts): what they depend on cannot be told (src/env.ts uses readFileSync)',
        fix: 'keep what reads files by a path no import names out of what those gates and their specs import',
      },
    ]);
    const two = [...blindGates, { gate: 'src/c.ts', reason: 'src/c.ts uses readdirSync' }];
    expect(diagnose({ ...healthy, blindGates: two })[0]?.text).toBe(
      'with --affected, a change of any file runs 3 of 3 gate(s) again (src/a.ts, src/b.ts, src/c.ts): what they depend on cannot be told (src/env.ts uses readFileSync (and 1 more reason(s)))'
    );
    // A hook without --affected is still worth changing: the other gates are told apart.
    const plain = [{ file: '.husky/pre-push', affected: false }];
    expect(diagnose({ ...healthy, hooks: plain, blindGates }).map((one) => one.level)).toEqual([
      'note',
      'problem',
    ]);
    // With every gate blind, --affected tells none apart: as for a cause of every gate.
    expect(diagnose({ ...healthy, hooks: plain, blindGates: two }).map((one) => one.level)).toEqual(
      ['note']
    );
    expect(diagnose({ ...healthy, blindGates: two }).map((one) => one.level)).toEqual(['problem']);
    const mixed = [...plain, { file: 'lefthook.yml', affected: true }];
    expect(diagnose({ ...healthy, hooks: mixed, blindGates: two }).map((one) => one.level)).toEqual(
      ['problem']
    );
    expect(diagnose({ ...healthy, blindGates }).map((one) => one.level)).toEqual(['note']);
    // What concerns every gate is said alone.
    expect(
      diagnose({ ...healthy, blind: 'src/db.ts uses readdirSync', blindGates }).map(
        (one) => one.text
      )
    ).toEqual([
      'with --affected, a change of any file runs every mutant: what a gate depends on cannot be told (src/db.ts uses readdirSync)',
    ]);
  });

  it('names a Stryker config that sets force', () => {
    expect(diagnose({ ...healthy, forced: true })).toEqual([
      {
        level: 'problem',
        text: 'the Stryker config sets force: every run is one of every mutant',
        fix: 'remove force from the Stryker config; pass -- --force where a full run is meant (CI)',
      },
    ]);
  });

  it('gives no fix for a listing that fails for another reason than a path outside', () => {
    expect(diagnose({ ...healthy, failure: 'the Stryker config could not be loaded' })).toEqual([
      {
        level: 'problem',
        text: 'the results of a run are never reused: the Stryker config could not be loaded',
        fix: null,
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

describe('hookUses', () => {
  const uses = (text: string, subproject = 'fee', script = 'test-gates mutation') =>
    hookUses({ file: '.husky/pre-push', text, subproject, script });
  const plain = { file: '.husky/pre-push', affected: false };
  const given = { file: '.husky/pre-push', affected: true };

  it('finds a run of the subproject the line names, and whether it is given --affected', () => {
    expect(uses('cd fee && npx test-gates mutation\n')).toEqual([plain]);
    expect(uses('npx test-gates mutation --dir ./fee/ --affected\n')).toEqual([given]);
    expect(uses('npm run test:gates:mutation --prefix=fee\n')).toEqual([plain]);
    expect(uses("npm -w 'fee' run test:gates:mutation\n", 'fee', 'x --affected')).toEqual([given]);
    expect(uses('node dist/test-gates.js mutation --workspace fee\n')).toEqual([plain]);
  });

  it('leaves out a run of another subproject', () => {
    expect(uses('cd tax && npx test-gates mutation\n')).toEqual([]);
    expect(uses('npx test-gates mutation --dir tax\n')).toEqual([]);
  });

  it('takes the nearest cd before the line, and a variable or none for any subproject', () => {
    expect(uses('cd fee\nnpm test\nnpm run test:gates:mutation\ncd ..\n')).toEqual([plain]);
    expect(uses('cd tax\ncd fee\nnpm run test:gates:mutation\n')).toEqual([plain]);
    expect(uses('cd fee\ncd tax\nnpm run test:gates:mutation\n')).toEqual([]);
    expect(uses('(cd "$project" && npm run test:gates:mutation)\n')).toEqual([plain]);
    expect(uses('cd ../fee && npx test-gates mutation\n')).toEqual([plain]);
    expect(uses('npx test-gates mutation\n')).toEqual([plain]);
  });

  it('takes --affected of the npm script only for a run through it', () => {
    expect(uses('npm run test:gates:mutation\n', 'fee', 'test-gates mutation --affected')).toEqual([
      given,
    ]);
    expect(uses('npx test-gates mutation\n', 'fee', 'test-gates mutation --affected')).toEqual([
      plain,
    ]);
  });

  it('counts each run, and reads no comment and no other command', () => {
    expect(
      uses('npx test-gates mutation --affected\nnpx test-gates mutation # later: --affected\n')
    ).toEqual([given, plain]);
    expect(uses('# npx test-gates mutation\n  # npm run test:gates:mutation\n')).toEqual([]);
    expect(uses('npx test-gates mutation-result\nnpm run test:gates:mutation-ci\n')).toEqual([]);
    expect(uses('npm run test:gates:mutation:quick\nnpx test-gates mutations\n')).toEqual([]);
    expect(uses('npx my-test-gates mutation\n')).toEqual([]);
  });

  it('reads the names as they are written: with more spaces, in quotes, in a directory below', () => {
    expect(uses('npx test-gates  mutation\n')).toEqual([plain]);
    expect(uses('npx test-gates mutation --dir  tax\n')).toEqual([]);
    expect(uses("npx test-gates mutation --dir 'tax'\n")).toEqual([]);
    expect(uses('cd  tax && npx test-gates mutation\n')).toEqual([]);
    expect(uses('cd "tax" && npx test-gates mutation\n')).toEqual([]);
    expect(uses('cd pkg/fee && npx test-gates mutation\n', 'pkg/fee')).toEqual([plain]);
  });

  it('looks for the cd only before the line, from the first line on', () => {
    expect(uses('cd tax\nnpx test-gates mutation\n')).toEqual([]);
    expect(uses('cd tax\nnpm test\nnpx test-gates mutation\n')).toEqual([]);
    expect(uses('npx test-gates mutation\ncd tax\n')).toEqual([plain]);
    expect(uses('cd fee # go there\nnpx test-gates mutation\n')).toEqual([plain]);
  });

  it('takes the top of the repository for a subproject there', () => {
    expect(uses('npx test-gates mutation --dir .\n', '')).toEqual([plain]);
  });
});
