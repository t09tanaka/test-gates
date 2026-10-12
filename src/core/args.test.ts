import { describe, expect, it } from 'vitest';
import { parseArgs, UsageError } from './args';

const base = {
  command: null,
  help: false,
  version: false,
  dir: '.',
  report: null,
  file: null,
  mode: null,
  gates: [],
  shard: null,
  quick: false,
  jobs: null,
  rest: [],
};

describe('parseArgs', () => {
  it.each(['check', 'mutation', 'mutation-result', 'selfcheck', 'lcov'] as const)(
    'reads the command %s with defaults',
    (command) => {
      expect(parseArgs([command])).toEqual({ ...base, command });
    }
  );

  it('reads no arguments as no command', () => {
    expect(parseArgs([])).toEqual(base);
  });

  it.each([['--help'], ['-h']])('reads %s', (flag) => {
    expect(parseArgs([flag])).toEqual({ ...base, help: true });
    expect(parseArgs(['check', flag])).toEqual({ ...base, command: 'check', help: true });
  });

  it.each([['--version'], ['-v']])('reads %s', (flag) => {
    expect(parseArgs([flag])).toEqual({ ...base, version: true });
  });

  it('reads --dir in both forms, for every command', () => {
    expect(parseArgs(['check', '--dir', 'api']).dir).toBe('api');
    expect(parseArgs(['check', '--dir=api']).dir).toBe('api');
    expect(parseArgs(['lcov', '--dir', 'client']).dir).toBe('client');
    expect(parseArgs(['selfcheck', '--dir=a=b']).dir).toBe('a=b');
  });

  it('reads --report for mutation-result and --file for lcov', () => {
    expect(parseArgs(['mutation-result', '--report', 'r.json', '--dir', 'x'])).toEqual({
      ...base,
      command: 'mutation-result',
      report: 'r.json',
      dir: 'x',
    });
    expect(parseArgs(['lcov', '--file=coverage/lcov.info'])).toEqual({
      ...base,
      command: 'lcov',
      file: 'coverage/lcov.info',
    });
  });

  it('keeps reading after an option written as --name=value', () => {
    expect(parseArgs(['lcov', '--file=a.info', '--dir=client', '--help'])).toEqual({
      ...base,
      command: 'lcov',
      file: 'a.info',
      dir: 'client',
      help: true,
    });
  });

  it('reads --all and --first for selfcheck', () => {
    expect(parseArgs(['selfcheck', '--all']).mode).toBe('all');
    expect(parseArgs(['selfcheck', '--first']).mode).toBe('first');
    expect(parseArgs(['selfcheck', '--first', '--first']).mode).toBe('first');
  });

  it('forwards unknown arguments of mutation to Stryker, with or without "--"', () => {
    expect(parseArgs(['mutation', '--force', '--concurrency', '1']).rest).toEqual([
      '--force',
      '--concurrency',
      '1',
    ]);
    expect(parseArgs(['mutation', '--', '--force', '--concurrency=1']).rest).toEqual([
      '--force',
      '--concurrency=1',
    ]);
    expect(parseArgs(['mutation', '--dir', 'api', '--force', '--', '--dir', 'x'])).toEqual({
      ...base,
      command: 'mutation',
      dir: 'api',
      rest: ['--force', '--dir', 'x'],
    });
  });

  it('passes everything after "--" through untouched, including --help', () => {
    expect(parseArgs(['mutation', '--', '--help', '-v'])).toEqual({
      ...base,
      command: 'mutation',
      rest: ['--help', '-v'],
    });
  });

  it('reads the gate command of selfcheck after "--"', () => {
    expect(parseArgs(['selfcheck', '--first', '--', 'npx', 'jest', '-c', 'x.js'])).toEqual({
      ...base,
      command: 'selfcheck',
      mode: 'first',
      rest: ['npx', 'jest', '-c', 'x.js'],
    });
  });

  it('reads --quick of selfcheck, alone and next to a selection', () => {
    expect(parseArgs(['selfcheck', '--quick'])).toEqual({
      ...base,
      command: 'selfcheck',
      quick: true,
    });
    expect(parseArgs(['selfcheck', '--shard', '1/2', '--quick'])).toMatchObject({
      quick: true,
      shard: { index: 1, total: 2 },
      mode: null,
    });
    expect(parseArgs(['selfcheck', '--quick', '--first'])).toMatchObject({
      quick: true,
      mode: 'first',
    });
    expect(() => parseArgs(['selfcheck', '--quick=1'])).toThrow(
      new UsageError('--quick does not take a value')
    );
    expect(() => parseArgs(['check', '--quick'])).toThrow(
      new UsageError('unknown argument for check: --quick')
    );
    expect(parseArgs(['mutation', '--quick']).rest).toEqual(['--quick']);
  });

  it('reads --jobs of selfcheck, in both forms', () => {
    expect(parseArgs(['selfcheck', '--jobs', '4'])).toEqual({
      ...base,
      command: 'selfcheck',
      jobs: 4,
    });
    expect(parseArgs(['selfcheck', '--jobs=12', '--quick'])).toMatchObject({
      jobs: 12,
      quick: true,
    });
    expect(parseArgs(['selfcheck', '--jobs', '1', '--first']).jobs).toBe(1);
    expect(parseArgs(['selfcheck', '--jobs', '999']).jobs).toBe(999);
    expect(parseArgs(['selfcheck', '--jobs', '2', '--jobs', '3']).jobs).toBe(3);
    expect(parseArgs(['mutation', '--jobs', '4'])).toMatchObject({
      jobs: null,
      rest: ['--jobs', '4'],
    });
  });

  it.each(['0', '-1', '1000', '01', '1.5', 'four', ' 4', '4 ', '4\n', '４'])(
    'rejects --jobs %j',
    (value) => {
      expect(() => parseArgs(['selfcheck', `--jobs=${value}`])).toThrow(
        new UsageError(`--jobs needs a number from 1 to 999, got ${value}`)
      );
    }
  );

  it('collects every --gate of selfcheck, in both forms and in the order given', () => {
    expect(parseArgs(['selfcheck', '--gate', 'src/b.ts', '--gate=src/a.ts'])).toEqual({
      ...base,
      command: 'selfcheck',
      gates: ['src/b.ts', 'src/a.ts'],
    });
  });

  it.each([
    ['1/1', { index: 1, total: 1 }],
    ['2/2', { index: 2, total: 2 }],
    ['3/12', { index: 3, total: 12 }],
    ['10/12', { index: 10, total: 12 }],
  ])('reads --shard %s', (value, shard) => {
    expect(parseArgs(['selfcheck', '--shard', value])).toEqual({
      ...base,
      command: 'selfcheck',
      shard,
    });
    expect(parseArgs(['selfcheck', `--shard=${value}`]).shard).toEqual(shard);
  });

  it.each([
    '0/2',
    '3/2',
    '1/0',
    '01/2',
    '1/02',
    'a1/2',
    '1/2a',
    '1',
    '1/',
    '/2',
    '1-2',
    '-1/2',
    '1.5/2',
    ' 1/2',
    '1/2 ',
    '1 / 2',
    '1/2\n',
    '１/２',
    '1/9007199254740993',
  ])('rejects --shard %s', (value) => {
    const message = `--shard needs <index>/<total> with 1 <= index <= total (for example 2/4), got ${value}`;
    expect(() => parseArgs(['selfcheck', `--shard=${value}`])).toThrow(UsageError);
    expect(() => parseArgs(['selfcheck', `--shard=${value}`])).toThrow(new UsageError(message));
  });

  it.each([
    [['frobnicate'], 'unknown command: frobnicate'],
    [['--frob'], 'unknown argument: --frob'],
    [['check', '--report', 'x'], 'unknown argument for check: --report'],
    [['check', 'extra'], 'unknown argument for check: extra'],
    [['mutation-result', '--force'], 'unknown argument for mutation-result: --force'],
    [['selfcheck', '--file=x'], 'unknown argument for selfcheck: --file=x'],
    [['lcov', '--all'], 'unknown argument for lcov: --all'],
    [['--dir', 'x'], 'unknown argument: --dir'],
    [['check', '--dir'], '--dir needs a value'],
    [['check', '--dir='], '--dir needs a value'],
    [['lcov', '--file'], '--file needs a value'],
    [['selfcheck', '--all=1'], '--all does not take a value'],
    [['selfcheck', '--all', '--first'], '--all and --first cannot be combined'],
    [['selfcheck', '--first', '--all'], '--all and --first cannot be combined'],
    [['selfcheck', '--gate'], '--gate needs a value'],
    [['selfcheck', '--shard'], '--shard needs a value'],
    [['check', '--gate', 'src/a.ts'], 'unknown argument for check: --gate'],
    [['mutation-result', '--shard', '1/2'], 'unknown argument for mutation-result: --shard'],
    [['selfcheck', '--first', '--gate', 'src/a.ts'], '--first and --gate cannot be combined'],
    [['selfcheck', '--gate', 'src/a.ts', '--all'], '--all and --gate cannot be combined'],
    [['selfcheck', '--all', '--shard', '1/2'], '--all and --shard cannot be combined'],
    [['selfcheck', '--shard', '1/2', '--first'], '--first and --shard cannot be combined'],
    [['selfcheck', '--shard', '1/4', '--shard', '2/4'], '--shard can be given only once'],
    [['selfcheck', '--shard=1/4', '--shard=1/4'], '--shard can be given only once'],
    [
      ['selfcheck', '--', 'vitest', 'run', '--shard', '2/4'],
      '--shard after "--" would go to the gate command. Write it before "--"',
    ],
    [
      ['selfcheck', '--', 'jest', '--shard=2/4'],
      '--shard after "--" would go to the gate command. Write it before "--"',
    ],
    [
      ['selfcheck', '--first', '--', 'jest', '--gate', 'src/a.ts'],
      '--gate after "--" would go to the gate command. Write it before "--"',
    ],
    [['selfcheck', '--jobs'], '--jobs needs a value'],
    [['check', '--jobs', '2'], 'unknown argument for check: --jobs'],
    [
      ['selfcheck', '--', 'jest', '--jobs=2'],
      '--jobs after "--" would go to the gate command. Write it before "--"',
    ],
    [
      ['selfcheck', '--', 'jest', '--quick'],
      '--quick after "--" would go to the gate command. Write it before "--"',
    ],
    [
      ['selfcheck', '--', 'jest', '--gate=src/a.ts'],
      '--gate after "--" would go to the gate command. Write it before "--"',
    ],
    [
      ['selfcheck', '--shard', '1/2', '--gate', 'src/a.ts'],
      '--gate and --shard cannot be combined',
    ],
    [['check', '--'], '"--" is only accepted by the mutation and selfcheck commands'],
    [['lcov', '--', 'x'], '"--" is only accepted by the mutation and selfcheck commands'],
    [['--', 'x'], '"--" is only accepted by the mutation and selfcheck commands'],
    [['selfcheck', '--'], '"--" must be followed by the gate command'],
  ])('rejects %j', (argv, message) => {
    expect(() => parseArgs(argv)).toThrow(UsageError);
    expect(() => parseArgs(argv)).toThrow(new UsageError(message));
  });

  it('still hands --gate and --shard of the mutation command to Stryker, in every position', () => {
    expect(parseArgs(['mutation', '--gate', 'x', '--shard', '1/2', '--gate=y'])).toEqual({
      ...base,
      command: 'mutation',
      rest: ['--gate', 'x', '--shard', '1/2', '--gate=y'],
    });
    expect(parseArgs(['mutation', '--', '--shard', '1/2', '--gate']).rest).toEqual([
      '--shard',
      '1/2',
      '--gate',
    ]);
  });

  it('leaves alone a gate command whose arguments only start like the two options', () => {
    expect(
      parseArgs(['selfcheck', '--', 'jest', '--shardless', '--gates=1', 'x--shard', '--gateway'])
        .rest
    ).toEqual(['jest', '--shardless', '--gates=1', 'x--shard', '--gateway']);
  });

  it('accepts "mutation --" with nothing after it', () => {
    expect(parseArgs(['mutation', '--']).rest).toEqual([]);
  });
});
