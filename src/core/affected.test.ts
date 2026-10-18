import { describe, expect, it } from 'vitest';
import {
  type AffectedPlan,
  describePlan,
  gateDependencies,
  isNestedMock,
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
    'pkg/__mocks__/@acme/kit.ts',
    'pkg/src/node_modules/x/index.js',
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

  it.each([
    'pkg/README.md',
    'pkg/docs/a.markdown',
    'notes.txt',
    'pkg/a.RST',
    'pkg/a.adoc',
    'pkg/src/a.html',
    'pkg/docs/a.htm',
    'pkg/reports/mutation/mutation.HTML',
    'pkg/report.html',
    'pkg/src/my-index.html',
    'pkg/src/index.html.html',
  ])('takes %s for a document', (key) => {
    expect(kindOf(key, 'pkg')).toBe('document');
  });

  it.each([
    // at the top of the subproject, outside of it, or of a kind that is not known
    'pkg/index.ts',
    'pkg/Makefile',
    'pkg/src/fixtures/a.yaml',
    'shared/round.ts',
    // a page that a build tool or a test runner may start from
    'pkg/index.html',
    'pkg/index.htm',
    'pkg/INDEX.HTML',
    'pkg/src/index.html',
    'pkg/coverage/index.html',
    'pkgx/src/a.ts',
    'pkg/src/a.ts.orig',
    'pkg/src/a.json5',
    'pkg/src/package.jsonx',
    'pkg/src/package-lock.jsonx',
    'pkg/src/test-gates.jsonx',
    'pkg/src/tsconfig.jsonx',
    'pkg/src/app.config.a.b.c',
    // a mock next to a module, which may also be used by name
    'pkg/src/__mocks__/rates.ts',
    'pkg/src/__mocks__/sub/rates.ts',
    'pkg/src/__mocks__/README.md',
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
    expect(kindOf('__mocks__/axios.ts', '')).toBe('config');
    expect(kindOf('src/__mocks__/rates.ts', '')).toBe('other');
    expect(kindOf('a/b/__mocks__/axios.ts', 'a/b')).toBe('config');
    expect(kindOf('a/b/src/__mocks__/rates.ts', 'a/b')).toBe('other');
    expect(kindOf('a/__mocks__/b/rates.ts', 'a/b')).toBe('other');
  });

  it('tells a mock below the top from the mock of a package at the top', () => {
    expect(isNestedMock('pkg/src/__mocks__/rates.ts', 'pkg')).toBe(true);
    expect(isNestedMock('pkg/src/__mocks__/sub/rates.ts', 'pkg')).toBe(true);
    expect(isNestedMock('pkg/__mocks__/axios.ts', 'pkg')).toBe(false);
    expect(isNestedMock('pkg/__mocks__/@acme/kit.ts', 'pkg')).toBe(false);
    expect(isNestedMock('pkg/src/__mocks__', 'pkg')).toBe(false);
    expect(isNestedMock('pkg/src/rates.ts', 'pkg')).toBe(false);
    expect(isNestedMock('src/__mocks__/rates.ts', '')).toBe(true);
    expect(isNestedMock('__mocks__/rates.ts', '')).toBe(false);
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

  it('makes a gate blind when one of the files it depends on is, through a spec as well', () => {
    const blind = { 'src/round.ts': 'src/round.ts uses readFileSync' };
    const found = gateDependencies({ gates, tests, covering: {}, closures, blind });
    expect(found['src/a.ts']?.blind).toBe('src/round.ts uses readFileSync');
    // b loads round itself, and through the spec of b
    expect(found['src/b.ts']?.blind).toBe('src/round.ts uses readFileSync');
    // Not blind: no such key at all, as the record writes it.
    expect(found['src/c.ts']).toStrictEqual({
      specs: ['src/c.spec.ts'],
      files: ['src/c.spec.ts', 'src/c.ts'],
    });
    // Only through a spec: the spec of a loads expect.ts, which neither gate a loads itself.
    const spec = gateDependencies({
      gates,
      tests,
      covering: { 'src/c.ts': ['src/a.spec.ts'] },
      closures,
      blind: { 'src/expect.ts': 'src/expect.ts uses readdirSync', 'src/z.ts': 'z' },
    });
    expect(spec['src/a.ts']?.blind).toBe('src/expect.ts uses readdirSync');
    expect(spec['src/c.ts']?.blind).toBe('src/expect.ts uses readdirSync');
    expect(spec['src/b.ts']?.blind).toBeUndefined();
    // the first file in order gives the reason
    const two = gateDependencies({
      gates,
      tests,
      covering: {},
      closures,
      blind: { 'src/round.ts': 'r', 'src/a.ts': 'a' },
    });
    expect(two['src/b.ts']?.blind).toBe('a');
    // not a property of every object
    expect(
      gateDependencies({
        gates: [{ key: 'constructor', specs: [] }],
        tests: [],
        covering: {},
        closures: {},
        blind: {},
      }).constructor
    ).toEqual({ specs: [], files: ['constructor'] });
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

  describe('a blind gate', () => {
    const blindNow = gates.map((gate) =>
      gate.path === 'src/c.ts' ? { ...gate, blind: 'pkg/src/c.ts uses readFileSync' } : gate
    );
    const blindBefore = {
      ...affected,
      gates: {
        ...affected.gates,
        'src/c.ts': { specs: [], files: sets['src/c.ts'], blind: 'pkg/src/c.ts uses readFileSync' },
      },
    };

    it('runs again for a change that no file of it is, and the others by what they load', () => {
      expect(plan({ 'pkg/src/round.ts': 'r2' }, { gates: blindNow })).toEqual({
        rerun: [
          { gate: 'src/a.ts', changed: ['pkg/src/round.ts'] },
          { gate: 'src/b.ts', changed: ['pkg/src/round.ts'] },
          {
            gate: 'src/c.ts',
            changed: ['pkg/src/round.ts'],
            blind: 'pkg/src/c.ts uses readFileSync',
          },
        ],
        reused: [],
      });
      // a file that only the blind gate may read, and that no gate loads
      expect(plan({ 'pkg/src/data.json': 'd1' }, { gates: blindNow })).toEqual({
        rerun: [
          {
            gate: 'src/c.ts',
            changed: ['pkg/src/data.json'],
            blind: 'pkg/src/c.ts uses readFileSync',
          },
        ],
        reused: ['src/a.ts', 'src/b.ts'],
      });
    });

    it('is blind when the last run wrote it down as such, though it is not now', () => {
      expect(
        plan({ 'pkg/src/a.ts': 'a2' }, { before: { files: before, affected: blindBefore } })
      ).toEqual({
        rerun: [
          { gate: 'src/a.ts', changed: ['pkg/src/a.ts'] },
          { gate: 'src/b.ts', changed: ['pkg/src/a.ts'] },
          { gate: 'src/c.ts', changed: ['pkg/src/a.ts'], blind: 'pkg/src/c.ts uses readFileSync' },
        ],
        reused: [],
      });
    });

    it('is reused when nothing changed', () => {
      expect(plan({}, { gates: blindNow })).toEqual({
        rerun: [],
        reused: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
      });
      expect(plan({}, { before: { files: before, affected: blindBefore } })).toEqual({
        rerun: [],
        reused: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
      });
      expect(plan({}, { gates: blindNow, seeded: false })).toEqual(plan({}, { gates: blindNow }));
    });

    it('is run again when nothing changed, with the record of another worktree', () => {
      const rerun = {
        rerun: [{ gate: 'src/c.ts', changed: [], blind: 'pkg/src/c.ts uses readFileSync' }],
        reused: ['src/a.ts', 'src/b.ts'],
      };
      expect(plan({}, { gates: blindNow, seeded: true })).toEqual(rerun);
      expect(plan({}, { before: { files: before, affected: blindBefore }, seeded: true })).toEqual(
        rerun
      );
      // the gates that are not blind are told apart as ever
      expect(plan({}, { seeded: true })).toEqual(plan({}));
      expect(plan({ 'pkg/src/a.ts': 'a2' }, { gates: blindNow, seeded: true })).toEqual(
        plan({ 'pkg/src/a.ts': 'a2' }, { gates: blindNow })
      );
    });

    it('is run again without a result of the last run, and a change for every gate is still one', () => {
      const missing = { ...affected, gates: { 'src/a.ts': affected.gates['src/a.ts'] } };
      expect(
        plan(
          {},
          { gates: blindNow, before: { files: before, affected: missing as typeof affected } }
        )
      ).toEqual({
        rerun: [
          { gate: 'src/b.ts', changed: [] },
          { gate: 'src/c.ts', changed: [] },
        ],
        reused: ['src/a.ts'],
      });
      expect(plan({ 'pkg/package.json': 'p2' }, { gates: blindNow })).toHaveProperty('full');
    });
  });

  describe('a mock below the top of the subproject', () => {
    const mock = 'pkg/src/__mocks__/round.ts';
    const withMock = { ...before, [mock]: 'k1' };
    const loading = gates.map((gate) =>
      gate.path === 'src/c.ts' ? gate : { ...gate, files: [...gate.files, mock] }
    );
    const mocked = (
      now: Record<string, string>,
      changes: Partial<Parameters<typeof planAffected>[0]> = {}
    ): AffectedPlan =>
      planAffected({
        before: { files: withMock, affected },
        now,
        subproject: 'pkg',
        config: [],
        gates: loading,
        ...changes,
      });

    it('runs again only the gates that load it', () => {
      expect(mocked({ ...withMock, [mock]: 'k2' })).toEqual({
        rerun: [
          { gate: 'src/a.ts', changed: [mock] },
          { gate: 'src/b.ts', changed: [mock] },
        ],
        reused: ['src/c.ts'],
      });
    });

    it('runs every mutant when no gate loads it', () => {
      expect(mocked({ ...withMock, [mock]: 'k2' }, { gates })).toEqual({
        full: `changed since the last run, and may affect every gate: ${mock}`,
      });
    });

    it('runs every mutant when it is named as a package', () => {
      expect(mocked({ ...withMock, [mock]: 'k2' }, { config: [mock] })).toEqual({
        full: `changed since the last run, and may affect every gate: ${mock}`,
      });
    });

    it('runs every mutant when it is gone, as it may have been one of a package', () => {
      expect(mocked(before)).toEqual({
        full: `changed since the last run, and may affect every gate: ${mock}`,
      });
      // One that is new is loaded by the gates now, or named as a package.
      expect(
        planAffected({
          before: { files: before, affected },
          now: withMock,
          subproject: 'pkg',
          config: [],
          gates: loading,
        })
      ).toEqual({
        rerun: [
          { gate: 'src/a.ts', changed: [mock] },
          { gate: 'src/b.ts', changed: [mock] },
        ],
        reused: ['src/c.ts'],
      });
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

  it('ignores a change of a page that no gate depends on, such as a report or the docs', () => {
    expect(
      plan({
        'pkg/reports/mutation/mutation.html': 'h1',
        'pkg/docs/guide.htm': 'g1',
        'pkg/report.html': 'r1',
      })
    ).toEqual({ rerun: [], reused: ['src/a.ts', 'src/b.ts', 'src/c.ts'] });
  });

  it('runs a gate again for a page that it loads', () => {
    const page = gates.map((gate) =>
      gate.path === 'src/c.ts' ? { ...gate, files: [...gate.files, 'pkg/src/c.html'] } : gate
    );
    expect(plan({ 'pkg/src/c.html': 'h2' }, { gates: page })).toEqual({
      rerun: [{ gate: 'src/c.ts', changed: ['pkg/src/c.html'] }],
      reused: ['src/a.ts', 'src/b.ts'],
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
    ['the page a build tool may start from', 'pkg/index.html'],
    ['a page a build tool may start from, below the top', 'pkg/src/index.html'],
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
      full: 'the last run did not write down what each gate depends on (it ran in CI, with an older version, or could not tell)',
    });
  });
});

describe('timeoutRanges', () => {
  const at = (line: number, column: number, endLine: number, endColumn: number) => ({
    start: { line, column },
    end: { line: endLine, column: endColumn },
  });
  const timeout = (location: ReturnType<typeof at>, status = 'Timeout') => ({
    status,
    mutatorName: 'BlockStatement',
    replacement: '{}',
    location,
  });
  const last = {
    files: {
      'src/a.ts': {
        mutants: [
          timeout(at(3, 10, 5, 4)),
          timeout(at(1, 1, 1, 9), 'Killed'),
          timeout(at(3, 10, 5, 4)),
          timeout(at(2, 1, 2, 9), 'Survived'),
          timeout(at(7, 1, 7, 2)),
        ],
      },
      'src/b.ts': { mutants: [timeout(at(1, 5, 1, 6))] },
      'src/c.ts': {},
      constructor: { mutants: [timeout(at(1, 1, 1, 2))] },
    },
  };
  const ranges = (report: Parameters<typeof timeoutRanges>[0], paths: string[]) =>
    timeoutRanges(
      report,
      paths.map((path) => ({ path }))
    );

  it('finds the gate named with a leading ./ under the name Stryker gives it', () => {
    expect(ranges(last, ['./src/b.ts'])).toEqual({
      ranges: ['src/b.ts:1:4-1:6'],
      rerun: 1,
      expected: 0,
    });
    expect(ranges(last, ['src/./b.ts']).ranges).toEqual(['src/b.ts:1:4-1:6']);
  });

  it('gives each timed-out mutant of the named gates once, as a range for --mutate', () => {
    expect(ranges(last, ['src/a.ts', 'src/c.ts', 'src/gone.ts'])).toEqual({
      ranges: ['src/a.ts:3:9-5:4', 'src/a.ts:7:0-7:2'],
      // two of them at the same place share a range
      rerun: 3,
      expected: 0,
    });
    expect(ranges(last, ['src/b.ts', 'src/a.ts']).ranges).toEqual([
      'src/b.ts:1:4-1:6',
      'src/a.ts:3:9-5:4',
      'src/a.ts:7:0-7:2',
    ]);
    expect(ranges(last, [])).toEqual({ ranges: [], rerun: 0, expected: 0 });
    expect(ranges({}, ['src/a.ts'])).toEqual({ ranges: [], rerun: 0, expected: 0 });
    expect(ranges({ files: {} }, ['toString'])).toEqual({ ranges: [], rerun: 0, expected: 0 });
    expect(ranges(last, ['constructor']).ranges).toEqual(['constructor:1:0-1:2']);
    // a gate the report holds no entry for
    expect(ranges({ files: { 'src/a.ts': undefined as never } }, ['src/a.ts'])).toEqual({
      ranges: [],
      rerun: 0,
      expected: 0,
    });
  });

  // `while (i < n) { i += 1; }`: the loop body sits at columns 16..26 of line 2.
  const SOURCE = 'let i = 0;\nwhile (i < n) { i += 1; }\nconst x = { a: 1 };\n';
  const loop = (status = 'Timeout') => timeout(at(2, 15, 2, 26), status);
  const object = (status = 'Timeout') => ({
    status,
    mutatorName: 'ObjectLiteral',
    replacement: '{}',
    location: at(3, 11, 3, 19),
  });
  const listed = {
    mutator: 'BlockStatement',
    original: '{ i += 1; }',
    replacement: '{}',
    reason: 'the loop no longer ends',
  };

  it('takes over a timeout that an expectedTimeouts entry of its gate points at', () => {
    const report = { files: { 'src/a.ts': { source: SOURCE, mutants: [loop(), object()] } } };
    expect(timeoutRanges(report, [{ path: './src/a.ts', expectedTimeouts: [listed] }])).toEqual({
      ranges: ['src/a.ts:3:10-3:19'],
      rerun: 1,
      expected: 1,
    });
    // without the entry, both are run again
    expect(timeoutRanges(report, [{ path: 'src/a.ts' }])).toEqual({
      ranges: ['src/a.ts:2:14-2:26', 'src/a.ts:3:10-3:19'],
      rerun: 2,
      expected: 0,
    });
    // an entry of another gate does not count
    const two = { files: { ...report.files, 'src/b.ts': { source: SOURCE, mutants: [] } } };
    expect(
      timeoutRanges(two, [{ path: 'src/a.ts' }, { path: 'src/b.ts', expectedTimeouts: [listed] }])
        .expected
    ).toBe(0);
  });

  it('counts only the entries that point at a mutant that timed out', () => {
    const report = {
      files: { 'src/a.ts': { source: SOURCE, mutants: [loop('Killed'), object()] } },
    };
    expect(timeoutRanges(report, [{ path: 'src/a.ts', expectedTimeouts: [listed] }])).toEqual({
      ranges: ['src/a.ts:3:10-3:19'],
      rerun: 1,
      expected: 0,
    });
  });

  it('takes nothing over from results that carry no source', () => {
    const report = { files: { 'src/a.ts': { mutants: [loop()] } } };
    expect(timeoutRanges(report, [{ path: 'src/a.ts', expectedTimeouts: [listed] }])).toEqual({
      ranges: ['src/a.ts:2:14-2:26'],
      rerun: 1,
      expected: 0,
    });
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

  it('says how many timed-out mutants are taken over because expectedTimeouts lists them', () => {
    expect(describePlan({ rerun: [], reused: ['src/a.ts'] }, 5, 2, 3)).toEqual([
      'test-gates mutation --affected: 1 of 1 gate(s) reused, 0 run again',
      '  and 2 mutant(s) of reused gates that timed out in the last run',
      '  3 mutant(s) that timed out in the last run are taken over: expectedTimeouts lists them',
    ]);
    expect(describePlan({ rerun: [], reused: ['src/a.ts'] }, 5, 0, 1)).toEqual([
      'test-gates mutation --affected: 1 of 1 gate(s) reused, 0 run again',
      '  1 mutant(s) that timed out in the last run are taken over: expectedTimeouts lists them',
    ]);
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

  it('counts the gates run again for any change, with why, and lists only the others', () => {
    expect(
      describePlan(
        {
          rerun: [
            { gate: 'src/a.ts', changed: ['x'], blind: 'src/env.ts uses readFileSync' },
            { gate: 'src/b.ts', changed: ['x'] },
            { gate: 'src/c.ts', changed: ['x'], blind: 'src/env.ts uses readFileSync' },
          ],
          reused: ['src/d.ts'],
        },
        1,
        2
      )
    ).toEqual([
      'test-gates mutation --affected: 1 of 4 gate(s) reused, 3 run again',
      '  src/b.ts: changed x',
      '  2 gate(s) run again for any change, as what they depend on cannot be told: src/env.ts uses readFileSync',
      '  and 2 mutant(s) of reused gates that timed out in the last run',
    ]);
    const blind = ['a', 'b', 'c'].map((name) => ({
      gate: `src/${name}.ts`,
      changed: ['x'],
      blind: name === 'a' ? 'one' : 'two',
    }));
    expect(describePlan({ rerun: blind, reused: [] }, 1)).toEqual([
      'test-gates mutation --affected: 0 of 3 gate(s) reused, 3 run again',
      '  3 gate(s) run again for any change, as what they depend on cannot be told: one (and 1 more reason(s))',
    ]);
    // the blind gates take no place among those listed
    const told = ['d', 'e'].map((name) => ({ gate: `src/${name}.ts`, changed: ['x'] }));
    expect(describePlan({ rerun: [...blind, ...told], reused: [] }, 2)).toEqual([
      'test-gates mutation --affected: 0 of 5 gate(s) reused, 5 run again',
      '  src/d.ts: changed x',
      '  src/e.ts: changed x',
      '  3 gate(s) run again for any change, as what they depend on cannot be told: one (and 1 more reason(s))',
    ]);
    expect(describePlan({ rerun: [...told, ...told], reused: [] }, 3).at(-1)).toBe('  and 1 more');
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
