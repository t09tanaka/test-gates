import { describe, expect, it } from 'vitest';
import {
  comparableArgs,
  incrementalOptions,
  parseRecord,
  readRecord,
  RECORD_FORMAT,
  refuseReuse,
  reportFiles,
  type Snapshot,
  strykerIgnores,
} from './reuse-guard';

const snapshot = (changes: Partial<Snapshot> = {}): Snapshot => ({
  mode: 'git',
  environment: { 'Node.js': 'v22.22.0', vitest: '3.2.7' },
  args: ['--concurrency', '2'],
  files: { 'package-lock.json': 'aa', 'src/rates.ts': 'bb', 'test-gates.json': 'cc' },
  ...changes,
});
const record = (changes: object = {}) => ({
  format: 3,
  incremental: 'hash-of-incremental',
  snapshot: snapshot(),
  ...changes,
});
const ask = (stored: unknown, now: Snapshot = snapshot(), incremental = 'hash-of-incremental') =>
  refuseReuse({ record: stored, incremental, snapshot: now });

describe('refuseReuse', () => {
  it('allows the reuse when nothing but gates and specs can have changed', () => {
    expect(RECORD_FORMAT).toBe(3);
    expect(ask(record())).toBeNull();
    // The order of the keys says nothing.
    expect(
      ask(
        record(),
        snapshot({
          files: { 'test-gates.json': 'cc', 'src/rates.ts': 'bb', 'package-lock.json': 'aa' },
          environment: { vitest: '3.2.7', 'Node.js': 'v22.22.0' },
        })
      )
    ).toBeNull();
  });

  it('refuses without a record', () => {
    expect(ask(undefined)).toBe('there is no record of the run that wrote the incremental file');
  });

  it.each([
    ['null', null],
    ['a string', 'x'],
    ['an array', [record()]],
    ['another format', record({ format: 1 })],
    // 2 knew no blind gate
    ['of the format before', record({ format: 2 })],
    ['a format written as text', record({ format: '3' })],
    ['no format', record({ format: undefined })],
    ['no hash of the incremental file', record({ incremental: undefined })],
    ['a hash that is not text', record({ incremental: 1 })],
    ['no snapshot', record({ snapshot: undefined })],
    ['a snapshot that is null', record({ snapshot: null })],
    ['a snapshot that is text', record({ snapshot: 'x' })],
    ['an unknown mode', record({ snapshot: { ...snapshot(), mode: 'guess' } })],
    ['no mode', record({ snapshot: { ...snapshot(), mode: undefined } })],
    ['arguments that are not a list', record({ snapshot: { ...snapshot(), args: 'x' } })],
    ['an argument that is not text', record({ snapshot: { ...snapshot(), args: ['a', 1] } })],
    ['no environment', record({ snapshot: { ...snapshot(), environment: undefined } })],
    ['an environment that is null', record({ snapshot: { ...snapshot(), environment: null } })],
    ['an environment that is a list', record({ snapshot: { ...snapshot(), environment: [] } })],
    ['a version that is not text', record({ snapshot: { ...snapshot(), environment: { a: 1 } } })],
    ['no files', record({ snapshot: { ...snapshot(), files: undefined } })],
    ['files that are a list', record({ snapshot: { ...snapshot(), files: ['a'] } })],
    [
      'a hash of a file that is not text',
      record({ snapshot: { ...snapshot(), files: { a: null } } }),
    ],
    ['an affected part that is null', record({ affected: null })],
    ['an affected part without tests', record({ affected: { gates: {} } })],
    ['tests that are not text', record({ affected: { tests: [1], gates: {} } })],
    ['no gates in the affected part', record({ affected: { tests: [] } })],
    ['gates that are null', record({ affected: { tests: [], gates: null } })],
    ['gates that are a list', record({ affected: { tests: [], gates: [] } })],
    ['a gate that is null', record({ affected: { tests: [], gates: { 'src/a.ts': null } } })],
    [
      'a gate without specs',
      record({ affected: { tests: [], gates: { 'src/a.ts': { files: [] } } } }),
    ],
    [
      'a gate with files that are not text',
      record({ affected: { tests: [], gates: { 'src/a.ts': { specs: [], files: [1] } } } }),
    ],
    [
      'a gate blind for a reason that is not text',
      record({
        affected: { tests: [], gates: { 'src/a.ts': { specs: [], files: [], blind: 1 } } },
      }),
    ],
  ])('refuses a record that is %s', (_name, stored) => {
    expect(parseRecord(stored)).toBeNull();
    expect(ask(stored)).toBe('the record of the last run is not one this version can read');
  });

  it('reads a complete record back as it was written, in walk mode too', () => {
    expect(parseRecord(record())).toEqual(record());
    const walked = record({ snapshot: snapshot({ mode: 'walk', args: [], files: {} }) });
    expect(parseRecord(walked)).toEqual(walked);
    expect(parseRecord({ ...record(), extra: 1 })).toEqual(record());
    const affected = {
      tests: ['src/a.spec.ts'],
      gates: {
        'src/a.ts': { specs: ['src/a.spec.ts'], files: ['src/a.ts', 'src/a.spec.ts'] },
        constructor: { specs: [], files: [] },
        'src/b.ts': { specs: [], files: ['src/b.ts'], blind: 'src/b.ts uses readFileSync' },
      },
    };
    expect(parseRecord(record({ affected }))).toEqual(record({ affected }));
    // A gate that is not blind gets no such key.
    expect(
      Object.keys(parseRecord(record({ affected }))?.affected?.gates['src/a.ts'] ?? {})
    ).toEqual(['specs', 'files']);
    expect(parseRecord(record({ affected: { ...affected, extra: 1 } }))?.affected).toEqual(
      affected
    );
  });

  it('gives the record back from readRecord when only the files differ', () => {
    const changed = snapshot({ files: { 'src/rates.ts': 'b2' } });
    expect(
      readRecord({ record: record(), incremental: 'hash-of-incremental', snapshot: changed })
    ).toEqual({
      record: record(),
    });
    expect(readRecord({ record: undefined, incremental: 'x', snapshot: changed })).toEqual({
      refused: 'there is no record of the run that wrote the incremental file',
    });
  });

  it('refuses when the incremental file is not the one the recorded run wrote', () => {
    expect(ask(record(), snapshot(), 'another-hash')).toBe(
      'the incremental file is not the one the last recorded run wrote'
    );
  });

  it('refuses when the files were listed in another way', () => {
    expect(ask(record(), snapshot({ mode: 'walk' }))).toBe(
      'the files are listed in another way than in the last run (git, now walk)'
    );
  });

  it('refuses when a tool was updated, added or removed, and names it', () => {
    expect(
      ask(record(), snapshot({ environment: { 'Node.js': 'v22.22.1', vitest: '3.2.7' } }))
    ).toBe('the tools changed since the last run: Node.js v22.22.0 → v22.22.1');
    expect(
      ask(record(), snapshot({ environment: { 'Node.js': 'v22.22.0', jest: '30.0.0' } }))
    ).toBe('the tools changed since the last run: jest none → 30.0.0, vitest 3.2.7 → none');
  });

  it('names at most three of the things that changed, in alphabetical order', () => {
    const environment = { d: '2', c: '2', b: '2', a: '2', 'Node.js': 'v22.22.0', vitest: '3.2.7' };
    expect(ask(record(), snapshot({ environment }))).toBe(
      'the tools changed since the last run: a none → 2, b none → 2, c none → 2 and 1 more'
    );
    const three = { c: '2', b: '2', a: '2', 'Node.js': 'v22.22.0', vitest: '3.2.7' };
    expect(ask(record(), snapshot({ environment: three }))).toBe(
      'the tools changed since the last run: a none → 2, b none → 2, c none → 2'
    );
  });

  it('refuses when the arguments for Stryker differ, also in their order or their split', () => {
    const reason = 'the arguments for Stryker are not those of the last run';
    expect(ask(record(), snapshot({ args: ['--concurrency', '1'] }))).toBe(reason);
    expect(ask(record(), snapshot({ args: ['2', '--concurrency'] }))).toBe(reason);
    expect(ask(record(), snapshot({ args: [] }))).toBe(reason);
    expect(ask(record(), snapshot({ args: ['--concurrency 2'] }))).toBe(reason);
    expect(ask(record(), snapshot({ args: ['--concurrency', '2', ''] }))).toBe(reason);
    expect(
      ask(record({ snapshot: snapshot({ args: ['a', 'b'] }) }), snapshot({ args: ['a\nb'] }))
    ).toBe(reason);
  });

  it('refuses when a file changed, appeared or disappeared, and names it', () => {
    const reason = (names: string) => `changed since the last run: ${names}`;
    const files = snapshot().files;
    expect(ask(record(), snapshot({ files: { ...files, 'src/rates.ts': 'b2' } }))).toBe(
      reason('src/rates.ts')
    );
    expect(ask(record(), snapshot({ files: { ...files, 'src/new.ts': 'dd' } }))).toBe(
      reason('src/new.ts')
    );
    expect(
      ask(record(), snapshot({ files: { 'src/rates.ts': 'bb', 'test-gates.json': 'cc' } }))
    ).toBe(reason('package-lock.json'));
    expect(ask(record(), snapshot({ files: { z: '1', y: '1', x: '1', w: '1', v: '1' } }))).toBe(
      reason('package-lock.json, src/rates.ts, test-gates.json and 5 more')
    );
  });

  it('reports the incremental file before the tools, the tools before the arguments, those before the files', () => {
    const all = snapshot({ mode: 'walk', environment: {}, args: [], files: {} });
    expect(ask(record(), all, 'another-hash')).toContain('the incremental file is not');
    expect(ask(record(), all)).toContain('listed in another way');
    expect(ask(record(), { ...all, mode: 'git' })).toContain('the tools changed');
    expect(ask(record(), { ...all, mode: 'git', environment: snapshot().environment })).toContain(
      'the arguments for Stryker'
    );
  });
});

describe('incrementalOptions', () => {
  const defaults = {
    incremental: false,
    force: false,
    incrementalFile: 'reports/stryker-incremental.json',
    tempDirName: '.stryker-tmp',
  };

  it('uses the defaults of Stryker for a config that says nothing', () => {
    expect(incrementalOptions({}, [])).toEqual(defaults);
    expect(incrementalOptions(undefined, [])).toEqual(defaults);
    expect(incrementalOptions(null, [])).toEqual(defaults);
    expect(incrementalOptions('x', [])).toEqual(defaults);
  });

  it('reads the config', () => {
    expect(
      incrementalOptions(
        { incremental: true, force: true, incrementalFile: 'tmp/inc.json', tempDirName: '.tmp' },
        []
      )
    ).toEqual({
      incremental: true,
      force: true,
      incrementalFile: 'tmp/inc.json',
      tempDirName: '.tmp',
    });
  });

  it('ignores values of the wrong type', () => {
    expect(
      incrementalOptions(
        { incremental: 'yes', force: 1, incrementalFile: 1, tempDirName: null },
        []
      )
    ).toEqual(defaults);
  });

  it('lets the arguments win over the config, in both forms, the last one given', () => {
    const config = { incremental: false, incrementalFile: 'a.json', tempDirName: '.a' };
    expect(
      incrementalOptions(config, ['--incremental', '--incrementalFile', 'b.json', '--force'])
    ).toEqual({ incremental: true, force: true, incrementalFile: 'b.json', tempDirName: '.a' });
    expect(
      incrementalOptions(config, ['--incrementalFile=c.json', '--tempDirName=.c', '--x'])
        .incrementalFile
    ).toBe('c.json');
    expect(incrementalOptions(config, ['--tempDirName', '.d']).tempDirName).toBe('.d');
    expect(incrementalOptions(config, ['--tempDirName=.e']).tempDirName).toBe('.e');
    expect(
      incrementalOptions(config, ['--incrementalFile', 'b.json', '--incrementalFile=c.json'])
        .incrementalFile
    ).toBe('c.json');
    expect(
      incrementalOptions(config, ['--incrementalFile=c.json', '--incrementalFile', 'b.json'])
        .incrementalFile
    ).toBe('b.json');
  });

  it('does not take an argument that only starts like the option, or one without a value', () => {
    const config = { incrementalFile: 'a.json' };
    expect(incrementalOptions(config, ['--incrementalFiles=b.json']).incrementalFile).toBe(
      'a.json'
    );
    expect(incrementalOptions(config, ['x--incrementalFile=b.json']).incrementalFile).toBe(
      'a.json'
    );
    expect(incrementalOptions(config, ['--incrementalFile']).incrementalFile).toBe('a.json');
    expect(incrementalOptions(config, ['--incrementalFile=']).incrementalFile).toBe('');
    expect(incrementalOptions({}, ['--forced', '--incrementally'])).toEqual(defaults);
  });
});

describe('comparableArgs', () => {
  it('leaves out --force and nothing else', () => {
    expect(comparableArgs(['--force', '--concurrency', '1', '--force', '--forced'])).toEqual([
      '--concurrency',
      '1',
      '--forced',
    ]);
    expect(comparableArgs([])).toEqual([]);
  });
});

describe('reportFiles', () => {
  it('takes the defaults of Stryker where the config names no file', () => {
    const defaults = ['reports/mutation/mutation.html', 'reports/mutation/mutation.json'];
    expect(reportFiles(undefined)).toEqual(defaults);
    expect(reportFiles({ htmlReporter: null, jsonReporter: 'x' })).toEqual(defaults);
    expect(reportFiles({ htmlReporter: { fileName: 1 }, jsonReporter: {} })).toEqual(defaults);
  });

  it('reads the file of each reporter', () => {
    expect(
      reportFiles({
        htmlReporter: { fileName: 'out/gates.html' },
        jsonReporter: { fileName: 'out/gates.json' },
      })
    ).toEqual(['out/gates.html', 'out/gates.json']);
  });
});

describe('strykerIgnores', () => {
  const ignored = (patterns: unknown, files: string[]): string[] => {
    const test = strykerIgnores({ ignorePatterns: patterns });
    return files.filter((file) => test(file));
  };

  it('leaves out nothing without patterns', () => {
    expect(strykerIgnores(undefined)('a.ts')).toBe(false);
    expect(strykerIgnores({ ignorePatterns: 1 })('1')).toBe(false);
    expect(ignored([1, ''], ['a.ts', '1'])).toEqual([]);
  });

  it('matches a name at any depth, and what lies below it', () => {
    expect(
      ignored(['.eslintcache', 'dist'], ['.eslintcache', 'a/.eslintcache', 'dist/x.js', 'distx'])
    ).toEqual(['.eslintcache', 'a/.eslintcache', 'dist/x.js']);
  });

  it('matches a path with a / from the subproject only', () => {
    const files = [
      'tsconfig.tsbuildinfo',
      'a/tsconfig.tsbuildinfo',
      'src/gen/x.ts',
      'a/src/gen/x.ts',
    ];
    expect(ignored(['/tsconfig.tsbuildinfo', 'src/gen'], files)).toEqual([
      'tsconfig.tsbuildinfo',
      'src/gen/x.ts',
    ]);
  });

  it('matches a pattern that ends in / to a directory only', () => {
    expect(ignored(['cache//'], ['cache', 'cache/x'])).toEqual(['cache/x']);
    expect(ignored(['cache/'], ['cache', 'cache/x', 'a/cache/x'])).toEqual([
      'cache/x',
      'a/cache/x',
    ]);
  });

  it('reads * and ? within a part, and a part ** for any parts', () => {
    const files = [
      'a.tsbuildinfo',
      'x/a.tsbuildinfo',
      'out/a/b/c.map',
      'out/c.map',
      'outc.map',
      'out/a.mapx',
      'log1.txt',
      'log12.txt',
      'log/1.txt',
      'deep',
      'x/y/deep/z',
      'xdeep',
      'src/a/b.d.ts',
    ];
    expect(
      ignored(['*.tsbuildinfo', 'out/**/*.map', 'log?.txt', '**/deep', 'src/*.d.ts'], files)
    ).toEqual([
      'a.tsbuildinfo',
      'x/a.tsbuildinfo',
      'out/a/b/c.map',
      'out/c.map',
      'log1.txt',
      'deep',
      'x/y/deep/z',
    ]);
  });

  it('takes every other character as it is written', () => {
    const patterns = ['a.b+c', 'p[q]', 'r{s,t}', '(u|v)', 'w^x$', 'y\\z'];
    const files = ['a.b+c', 'axb+c', 'a.bbc', 'p[q]', 'pq', 'r{s,t}', 'rs', '(u|v)', 'u', 'w^x$'];
    expect(ignored(patterns, [...files, 'y\\z', 'yz'])).toEqual([
      'a.b+c',
      'p[q]',
      'r{s,t}',
      '(u|v)',
      'w^x$',
      'y\\z',
    ]);
  });

  it('leaves out nothing where a pattern takes files back with !', () => {
    const files = ['reports/a.html', 'reports/keep.json', '.eslintcache'];
    expect(ignored(['reports', '.eslintcache'], files)).toEqual(files);
    expect(ignored(['reports', '!reports/keep.json', '.eslintcache'], files)).toEqual([]);
    expect(ignored(['!b.ts', 'a.ts'], ['a.ts'])).toEqual([]);
    expect(strykerIgnores({ ignorePatterns: ['!b.ts', 'a.ts'] })('a.ts')).toBe(false);
  });

  it('tells no case of letters apart, as Stryker does', () => {
    expect(ignored(['.ESLintCache', 'Src/Gen'], ['.eslintcache', 'src/gen/x.ts'])).toEqual([
      '.eslintcache',
      'src/gen/x.ts',
    ]);
  });
});
