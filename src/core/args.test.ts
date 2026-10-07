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
    [['check', '--'], '"--" is only accepted by the mutation and selfcheck commands'],
    [['lcov', '--', 'x'], '"--" is only accepted by the mutation and selfcheck commands'],
    [['--', 'x'], '"--" is only accepted by the mutation and selfcheck commands'],
    [['selfcheck', '--'], '"--" must be followed by the gate command'],
  ])('rejects %j', (argv, message) => {
    expect(() => parseArgs(argv)).toThrow(UsageError);
    expect(() => parseArgs(argv)).toThrow(new UsageError(message));
  });

  it('accepts "mutation --" with nothing after it', () => {
    expect(parseArgs(['mutation', '--']).rest).toEqual([]);
  });
});
