import { describe, expect, it } from 'vitest';
import {
  type AffectedPlan,
  describePlan,
  gateDependencies,
  kindOf,
  planAffected,
  timeoutRanges,
} from './affected';

describe('kindOf', () => {
  it.each([
    'pkg/package.json',
    'pkg/package-lock.json',
    'pkg/npm-shrinkwrap.json',
    'pkg/test-gates.json',
    'pkg/tsconfig.json',
    'pkg/tsconfig.build.json',
    'pkg/src/jsconfig.json',
    'pkg/vitest.config.ts',
    'pkg/stryker.gates.config.mjs',
    'pkg/vitest.config.e2e.ts',
    'pkg/jest.setup.ts',
    'pkg/jest-preset.js',
    'pkg/vitest.workspace.ts',
    'pkg/vite.config.mts',
    'pkg/babel.config.cjs',
    'pkg/stryker-plugin.js',
    'pkg/.babelrc',
    'pkg/src/.env',
    'pkg/src/types/global.d.ts',
    'pkg/src/types/global.d.mts',
    'pkg/src/types/global.d.cts',
    'pkg/__mocks__/axios.ts',
    'pkg/src/__mocks__/rates.ts',
    'pkg/node_modules/.package-lock.json',
    'pkg/node_modules/x/index.js',
    'pkg/src/app.config.ts',
    'pkg/src/app.config.e2e.ts',
    'package-lock.json',
    'other/package.json',
  ])('takes %s for a file that may affect every gate', (key) => {
    expect(kindOf(key, 'pkg')).toBe('config');
  });

  it.each([
    'pkg/src/a.ts',
    'pkg/src/a.tsx',
    'pkg/src/a.mts',
    'pkg/src/a.cjs',
    'pkg/src/a.jsx',
    'pkg/src/data/rates.json',
    'pkg/src/__snapshots__/a.spec.ts.snap',
    'pkg/src/a.css',
    'pkg/src/a.SCSS',
    'pkg/src/a.sass',
    'pkg/src/a.less',
    'pkg/assets/logo.svg',
    'pkg/assets/a.png',
    'pkg/assets/a.jpg',
    'pkg/assets/a.jpeg',
    'pkg/assets/a.gif',
    'pkg/assets/a.webp',
    'pkg/assets/a.avif',
    'pkg/assets/a.ico',
    'pkg/src/configured.ts',
    // only like the name of a config
    'pkg/src/my-package.json',
    'pkg/src/my-package-lock.json',
    'pkg/src/my-test-gates.json',
    'pkg/src/my-tsconfig.json',
    'pkg/src/myjest.setup.ts',
    'pkg/src/a.d.tsx',
    'pkg/src/a.md.ts',
  ])('takes %s for a file that matters only to what imports it', (key) => {
    expect(kindOf(key, 'pkg')).toBe('passive');
  });

  it.each(['pkg/README.md', 'pkg/docs/a.markdown', 'notes.txt', 'pkg/a.RST', 'pkg/a.adoc'])(
    'takes %s for a document',
    (key) => {
      expect(kindOf(key, 'pkg')).toBe('document');
    }
  );

  it.each([
    // at the top of the subproject, outside of it, or of a kind that is not known
    'pkg/index.ts',
    'pkg/Makefile',
    'pkg/src/fixtures/a.yaml',
    'pkg/src/a.html',
    'shared/round.ts',
    'pkgx/src/a.ts',
    'pkg/src/a.ts.orig',
    'pkg/src/a.json5',
    'pkg/src/package.jsonx',
    'pkg/src/package-lock.jsonx',
    'pkg/src/test-gates.jsonx',
    'pkg/src/tsconfig.jsonx',
    'pkg/src/app.config.a.b.c',
  ])('takes %s for another file', (key) => {
    expect(kindOf(key, 'pkg')).toBe('other');
  });

  it('reads the keys of a subproject at the root of what is listed', () => {
    expect(kindOf('src/a.ts', '')).toBe('passive');
    expect(kindOf('index.ts', '')).toBe('other');
    expect(kindOf('package.json', '')).toBe('config');
    expect(kindOf('src/.hidden/a.ts', '')).toBe('passive');
    expect(kindOf('a/b/src/a.ts', 'a/b')).toBe('passive');
    expect(kindOf('a/b/index.ts', 'a/b')).toBe('other');
  });
});

describe('gateDependencies', () => {
  const closures = {
    'src/a.ts': ['src/a.ts', 'src/round.ts'],
    'src/b.ts': ['src/b.ts'],
    'src/c.ts': ['src/c.ts'],
    'src/a.spec.ts': ['src/a.spec.ts', 'src/a.ts', 'src/round.ts', 'src/expect.ts'],
    'src/b.spec.ts': ['src/b.spec.ts', 'src/b.ts', 'src/a.ts', 'src/round.ts'],
    'src/c.spec.ts': ['src/c.spec.ts', 'src/c.ts'],
  };
  const gates = [
    { key: 'src/a.ts', specs: ['src/a.spec.ts'] },
    { key: 'src/b.ts', specs: ['src/b.spec.ts'] },
    { key: 'src/c.ts', specs: ['src/c.spec.ts'] },
  ];
  const tests = ['src/a.spec.ts', 'src/b.spec.ts', 'src/c.spec.ts'];

  it('takes the specs that import the gate, with what they import', () => {
    expect(gateDependencies({ gates, tests, covering: {}, closures })).toEqual({
      'src/a.ts': {
        specs: ['src/a.spec.ts', 'src/b.spec.ts'],
        files: [
          'src/a.spec.ts',
          'src/a.ts',
          'src/b.spec.ts',
          'src/b.ts',
          'src/expect.ts',
          'src/round.ts',
        ],
      },
      'src/b.ts': {
        specs: ['src/b.spec.ts'],
        files: ['src/a.ts', 'src/b.spec.ts', 'src/b.ts', 'src/round.ts'],
      },
      'src/c.ts': { specs: ['src/c.spec.ts'], files: ['src/c.spec.ts', 'src/c.ts'] },
    });
  });

  it('adds the specs that covered a mutant of the gate, and what they import', () => {
    const found = gateDependencies({
      gates,
      tests,
      covering: { 'src/c.ts': ['src/a.spec.ts'] },
      closures,
    });
    expect(found['src/c.ts']).toEqual({
      specs: ['src/a.spec.ts', 'src/c.spec.ts'],
      files: [
        'src/a.spec.ts',
        'src/a.ts',
        'src/c.spec.ts',
        'src/c.ts',
        'src/expect.ts',
        'src/round.ts',
      ],
    });
  });

  it('takes a file without a closure (a spec that is gone) for itself', () => {
    const found = gateDependencies({
      gates: [{ key: 'src/c.ts', specs: ['src/gone.spec.ts'] }],
      tests: ['src/gone.spec.ts'],
      covering: {},
      closures: { 'src/c.ts': ['src/c.ts'] },
    });
    expect(found['src/c.ts']).toEqual({
      specs: ['src/gone.spec.ts'],
      files: ['src/c.ts', 'src/gone.spec.ts'],
    });
    expect(
      gateDependencies({
        gates: [{ key: 'src/x.ts', specs: [] }],
        tests: [],
        covering: {},
        closures: {},
      })
    ).toEqual({ 'src/x.ts': { specs: [], files: ['src/x.ts'] } });
  });

  it('keeps a gate called like a property of every object', () => {
    const found = gateDependencies({
      gates: [{ key: 'constructor', specs: [] }],
      tests: ['toString'],
      covering: {},
      closures: {},
    });
    expect(Object.getPrototypeOf(found)).toBeNull();
    expect(found.constructor).toEqual({ specs: [], files: ['constructor'] });
    const recorded = { tests: [], gates: {} };
    expect(
      planAffected({
        before: { files: {}, affected: recorded },
        now: {},
        subproject: '',
        config: [],
        gates: [{ path: 'constructor', files: [] }],
      })
    ).toEqual({ rerun: [{ gate: 'constructor', changed: [] }], reused: [] });
  });
});

describe('planAffected', () => {
  const before = {
    'pkg/package.json': 'p1',
    'pkg/stryker.gates.config.mjs': 's1',
    'pkg/test/setup.ts': 't1',
    'pkg/src/a.ts': 'a1',
    'pkg/src/a.spec.ts': 'as1',
    'pkg/src/b.ts': 'b1',
    'pkg/src/b.spec.ts': 'bs1',
    'pkg/src/c.ts': 'c1',
    'pkg/src/c.spec.ts': 'cs1',
    'pkg/src/round.ts': 'r1',
    'pkg/src/other.ts': 'o1',
    'pkg/README.md': 'm1',
    'pkg/index.ts': 'i1',
    'shared/money.ts': 'm1',
    'shared/unused.ts': 'u1',
  };
  const sets = {
    'src/a.ts': ['pkg/src/a.ts', 'pkg/src/a.spec.ts', 'pkg/src/round.ts', 'pkg/src/b.spec.ts'],
    'src/b.ts': ['pkg/src/b.ts', 'pkg/src/b.spec.ts', 'pkg/src/a.ts', 'pkg/src/round.ts'],
    'src/c.ts': ['pkg/src/c.ts', 'pkg/src/c.spec.ts', 'shared/money.ts'],
  };
  const affected = {
    tests: ['src/a.spec.ts', 'src/b.spec.ts', 'src/c.spec.ts'],
    gates: Object.fromEntries(
      Object.entries(sets).map(([gate, files]) => [gate, { specs: [], files }])
    ),
  };
  const gates = Object.entries(sets).map(([path, files]) => ({ path, files }));
  const plan = (
    now: Record<string, string>,
    changes: Partial<Parameters<typeof planAffected>[0]> = {}
  ): AffectedPlan =>
    planAffected({
      before: { files: before, affected },
      now: { ...before, ...now },
      subproject: 'pkg',
      config: ['pkg/stryker.gates.config.mjs', 'pkg/test/setup.ts'],
      gates,
      ...changes,
    });

  it('reuses every gate when nothing changed', () => {
    expect(plan({})).toEqual({ rerun: [], reused: ['src/a.ts', 'src/b.ts', 'src/c.ts'] });
  });

  it('(a) runs a gate again when it changed, and keeps the gates that do not depend on it', () => {
    expect(plan({ 'pkg/src/c.ts': 'c2' })).toEqual({
      rerun: [{ gate: 'src/c.ts', changed: ['pkg/src/c.ts'] }],
      reused: ['src/a.ts', 'src/b.ts'],
    });
  });

  it('(b) runs every gate again that imports a helper that changed', () => {
    expect(plan({ 'pkg/src/round.ts': 'r2' })).toEqual({
      rerun: [
        { gate: 'src/a.ts', changed: ['pkg/src/round.ts'] },
        { gate: 'src/b.ts', changed: ['pkg/src/round.ts'] },
      ],
      reused: ['src/c.ts'],
    });
  });

  it('(c) runs B again when A changed and the spec of B imports A', () => {
    expect(plan({ 'pkg/src/a.ts': 'a2' })).toEqual({
      rerun: [
        { gate: 'src/a.ts', changed: ['pkg/src/a.ts'] },
        { gate: 'src/b.ts', changed: ['pkg/src/a.ts'] },
      ],
      reused: ['src/c.ts'],
    });
  });

  it('names every file that changed for a gate, in order', () => {
    expect(plan({ 'pkg/src/round.ts': 'r2', 'pkg/src/a.spec.ts': 'as2' })).toEqual({
      rerun: [
        { gate: 'src/a.ts', changed: ['pkg/src/a.spec.ts', 'pkg/src/round.ts'] },
        { gate: 'src/b.ts', changed: ['pkg/src/round.ts'] },
      ],
      reused: ['src/c.ts'],
    });
  });

  it('runs a gate again when a file it depended on in the last run changed or is gone', () => {
    // The spec of b no longer imports a; a changed as well.
    const now = { 'pkg/src/b.spec.ts': 'bs2', 'pkg/src/a.ts': 'a2' };
    const moved = gates.map((gate) =>
      gate.path === 'src/b.ts' ? { ...gate, files: ['pkg/src/b.ts', 'pkg/src/b.spec.ts'] } : gate
    );
    expect(plan(now, { gates: moved })).toEqual({
      rerun: [
        { gate: 'src/a.ts', changed: ['pkg/src/a.ts', 'pkg/src/b.spec.ts'] },
        { gate: 'src/b.ts', changed: ['pkg/src/a.ts', 'pkg/src/b.spec.ts'] },
      ],
      reused: ['src/c.ts'],
    });
    const gone = { ...before } as Record<string, string>;
    delete gone['pkg/src/round.ts'];
    expect(
      planAffected({
        before: { files: before, affected },
        now: gone,
        subproject: 'pkg',
        config: [],
        gates,
      })
    ).toEqual({
      rerun: [
        { gate: 'src/a.ts', changed: ['pkg/src/round.ts'] },
        { gate: 'src/b.ts', changed: ['pkg/src/round.ts'] },
      ],
      reused: ['src/c.ts'],
    });
  });

  it('runs a gate again when a file it depends on now appeared', () => {
    const grown = gates.map((gate) =>
      gate.path === 'src/c.ts' ? { ...gate, files: [...gate.files, 'pkg/src/new.ts'] } : gate
    );
    expect(plan({ 'pkg/src/new.ts': 'n1', 'pkg/src/c.spec.ts': 'cs2' }, { gates: grown })).toEqual({
      rerun: [{ gate: 'src/c.ts', changed: ['pkg/src/c.spec.ts', 'pkg/src/new.ts'] }],
      reused: ['src/a.ts', 'src/b.ts'],
    });
  });

  it('runs a gate again for a file outside the subproject that it depends on only now', () => {
    const grown = gates.map((gate) =>
      gate.path === 'src/c.ts' ? { ...gate, files: [...gate.files, 'shared/new.ts'] } : gate
    );
    expect(plan({ 'shared/new.ts': 'n1', 'pkg/src/c.spec.ts': 'cs2' }, { gates: grown })).toEqual({
      rerun: [{ gate: 'src/c.ts', changed: ['pkg/src/c.spec.ts', 'shared/new.ts'] }],
      reused: ['src/a.ts', 'src/b.ts'],
    });
  });

  it('runs a gate again when the last run left no result of it, and runs a new gate', () => {
    const kept = Object.fromEntries(
      Object.entries(affected.gates).filter(([gate]) => gate !== 'src/b.ts')
    );
    expect(
      planAffected({
        before: { files: before, affected: { ...affected, gates: kept } },
        now: before,
        subproject: 'pkg',
        config: [],
        gates,
      })
    ).toEqual({ rerun: [{ gate: 'src/b.ts', changed: [] }], reused: ['src/a.ts', 'src/c.ts'] });
  });

  it('(f) ignores a change of a source and of a document that no gate depends on', () => {
    expect(plan({ 'pkg/src/other.ts': 'o2', 'pkg/README.md': 'm2' })).toEqual({
      rerun: [],
      reused: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
    });
    expect(plan({ 'pkg/src/fresh.ts': 'f1' })).toEqual({
      rerun: [],
      reused: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
    });
  });

  it('takes a file outside the subproject that a gate depends on for that gate alone', () => {
    expect(plan({ 'shared/money.ts': 'm2' })).toEqual({
      rerun: [{ gate: 'src/c.ts', changed: ['shared/money.ts'] }],
      reused: ['src/a.ts', 'src/b.ts'],
    });
  });

  it('runs a gate again for a file only the last run depended on, outside the subproject too', () => {
    const now = gates.map((gate) =>
      gate.path === 'src/c.ts' ? { ...gate, files: ['pkg/src/c.ts', 'pkg/src/c.spec.ts'] } : gate
    );
    expect(plan({ 'shared/money.ts': 'm2', 'pkg/src/c.spec.ts': 'cs2' }, { gates: now })).toEqual({
      rerun: [{ gate: 'src/c.ts', changed: ['pkg/src/c.spec.ts', 'shared/money.ts'] }],
      reused: ['src/a.ts', 'src/b.ts'],
    });
  });

  it.each([
    ['(d) a config of the run', 'pkg/stryker.gates.config.mjs'],
    ['a setup file the config names', 'pkg/test/setup.ts'],
    ['(d) the manifest of the package', 'pkg/package.json'],
    ['a file at the top of the subproject', 'pkg/index.ts'],
    ['a file outside the subproject that no gate depends on', 'shared/unused.ts'],
    ['a new lock file', 'package-lock.json'],
  ])('runs every gate after a change of %s', (_name, key) => {
    expect(plan({ [key]: 'changed' })).toEqual({
      full: `changed since the last run, and may affect every gate: ${key}`,
    });
  });

  it('runs every gate when a config changed that a gate also depends on', () => {
    const json = gates.map((gate) =>
      gate.path === 'src/a.ts' ? { ...gate, files: [...gate.files, 'pkg/package.json'] } : gate
    );
    expect(plan({ 'pkg/package.json': 'p2' }, { gates: json })).toEqual({
      full: 'changed since the last run, and may affect every gate: pkg/package.json',
    });
    expect(plan({ 'pkg/src/a.ts': 'a2' }, { config: ['pkg/src/a.ts'] })).toEqual({
      full: 'changed since the last run, and may affect every gate: pkg/src/a.ts',
    });
  });

  it('names at most three of the files that may affect every gate', () => {
    expect(
      plan({
        'pkg/package.json': 'p2',
        'pkg/index.ts': 'i2',
        'pkg/test/setup.ts': 't2',
        'pkg/stryker.gates.config.mjs': 's2',
        'pkg/src/a.ts': 'a2',
      })
    ).toEqual({
      full: 'changed since the last run, and may affect every gate: pkg/index.ts, pkg/package.json, pkg/stryker.gates.config.mjs and 1 more',
    });
  });

  it('runs every gate when the last run did not write down what the gates depend on', () => {
    expect(
      planAffected({
        before: { files: before, affected: undefined },
        now: before,
        subproject: 'pkg',
        config: [],
        gates,
      })
    ).toEqual({
      full: 'the last run did not write down what each gate depends on (it ran without --affected)',
    });
  });
});

describe('timeoutRanges', () => {
  const at = (line: number, column: number, endLine: number, endColumn: number) => ({
    start: { line, column },
    end: { line: endLine, column: endColumn },
  });
  const last = {
    files: {
      'src/a.ts': {
        mutants: [
          { status: 'Timeout', location: at(3, 10, 5, 4) },
          { status: 'Killed', location: at(1, 1, 1, 9) },
          { status: 'Timeout', location: at(3, 10, 5, 4) },
          { status: 'Survived', location: at(2, 1, 2, 9) },
          { status: 'Timeout', location: at(7, 1, 7, 2) },
        ],
      },
      'src/b.ts': { mutants: [{ status: 'Timeout', location: at(1, 5, 1, 6) }] },
      'src/c.ts': {},
      constructor: { mutants: [{ status: 'Timeout', location: at(1, 1, 1, 2) }] },
    },
  };

  it('gives each timed-out mutant of the named gates once, as a range for --mutate', () => {
    expect(timeoutRanges(last, ['src/a.ts', 'src/c.ts', 'src/gone.ts'])).toEqual([
      'src/a.ts:3:9-5:4',
      'src/a.ts:7:0-7:2',
    ]);
    expect(timeoutRanges(last, ['src/b.ts', 'src/a.ts'])).toEqual([
      'src/b.ts:1:4-1:6',
      'src/a.ts:3:9-5:4',
      'src/a.ts:7:0-7:2',
    ]);
    expect(timeoutRanges(last, [])).toEqual([]);
    expect(timeoutRanges({}, ['src/a.ts'])).toEqual([]);
    expect(timeoutRanges({ files: {} }, ['toString'])).toEqual([]);
    expect(timeoutRanges(last, ['constructor'])).toEqual(['constructor:1:0-1:2']);
    // a gate the report holds no entry for
    expect(timeoutRanges({ files: { 'src/a.ts': undefined as never } }, ['src/a.ts'])).toEqual([]);
  });
});

describe('describePlan', () => {
  it('says how many timed-out mutants of reused gates run again', () => {
    expect(describePlan({ rerun: [], reused: ['src/a.ts'] }, 5, 2)).toEqual([
      'test-gates mutation --affected: 1 of 1 gate(s) reused, 0 run again',
      '  and 2 mutant(s) of reused gates that timed out in the last run',
    ]);
    expect(describePlan({ rerun: [], reused: ['src/a.ts'] }, 5, 1)).toHaveLength(2);
  });

  it('says why every mutant is run', () => {
    expect(describePlan({ full: 'a reason' })).toEqual([
      'test-gates mutation --affected: running every mutant again (--force), the results of the last run are not reused: a reason',
    ]);
  });

  it('says how many gates are reused, and why each of the others runs again', () => {
    expect(
      describePlan({
        rerun: [
          { gate: 'src/a.ts', changed: ['src/a.ts'] },
          { gate: 'src/b.ts', changed: [] },
        ],
        reused: ['src/c.ts'],
      })
    ).toEqual([
      'test-gates mutation --affected: 1 of 3 gate(s) reused, 2 run again',
      '  src/a.ts: changed src/a.ts',
      '  src/b.ts: the last run left no result of it that can be reused',
    ]);
    expect(describePlan({ rerun: [], reused: ['src/a.ts'] })).toEqual([
      'test-gates mutation --affected: 1 of 1 gate(s) reused, 0 run again',
    ]);
  });

  it('names a few gates and counts the rest', () => {
    const rerun = ['a', 'b', 'c'].map((name) => ({ gate: `src/${name}.ts`, changed: ['x'] }));
    expect(describePlan({ rerun, reused: [] }, 2)).toEqual([
      'test-gates mutation --affected: 0 of 3 gate(s) reused, 3 run again',
      '  src/a.ts: changed x',
      '  src/b.ts: changed x',
      '  and 1 more',
    ]);
    expect(describePlan({ rerun, reused: [] }, 3)).toHaveLength(4);
    const six = [...rerun, ...rerun];
    expect(describePlan({ rerun: six, reused: [] }).at(-1)).toBe('  and 1 more');
    expect(describePlan({ rerun: rerun.slice(0, 2), reused: [] }, 2)).toHaveLength(3);
  });
});
