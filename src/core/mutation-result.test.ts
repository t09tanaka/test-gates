import { describe, expect, it } from 'vitest';
import {
  formatSummary,
  formatSurvivor,
  judgeMutationReport,
  normalizeCode,
  sliceByLocation,
  type ReportMutant,
} from './mutation-result';
import type { EquivalentMutant, Gate } from './types';

// The gate under test in most cases. Line 1 and line 3 hold the same expression on purpose.
const SOURCE = [
  'export const isAdult = (age: number) => age >= 18;',
  'export const label = (ok: boolean) => (ok ? "yes" : "no");',
  'export const isSenior = (age: number) => age >= 18;',
  '',
].join('\n');

const GATE_PATH = 'src/age.ts';

function mutant(
  status: string,
  mutatorName: string,
  replacement: string,
  line: number,
  startColumn: number,
  endColumn: number
): ReportMutant {
  return {
    status,
    mutatorName,
    replacement,
    location: { start: { line, column: startColumn }, end: { line, column: endColumn } },
  };
}

// `age >= 18` sits at columns 41..50 of line 1 and columns 42..51 of line 3.
const firstComparison = (status: string, replacement = 'age > 18') =>
  mutant(status, 'EqualityOperator', replacement, 1, 41, 50);
const secondComparison = (status: string, replacement = 'age > 18') =>
  mutant(status, 'EqualityOperator', replacement, 3, 42, 51);
const yesLiteral = (status: string) => mutant(status, 'StringLiteral', '""', 2, 45, 50);

function gate(equivalentMutants?: EquivalentMutant[]): Gate {
  return {
    path: GATE_PATH,
    decides: 'who counts as an adult',
    impact: 'minors get adult pricing',
    ...(equivalentMutants ? { equivalentMutants } : {}),
  };
}

function judge(mutants: ReportMutant[], equivalentMutants?: EquivalentMutant[]) {
  return judgeMutationReport({
    gates: [gate(equivalentMutants)],
    report: { files: { [GATE_PATH]: { source: SOURCE, mutants } } },
    readSource: () => SOURCE,
  });
}

const allowance = (overrides: Partial<EquivalentMutant> = {}): EquivalentMutant => ({
  mutator: 'EqualityOperator',
  original: 'age >= 18',
  replacement: 'age > 18',
  reason: 'documented reason',
  ...overrides,
});

describe('sliceByLocation', () => {
  it('cuts a single-line range with 1-based columns and an exclusive end', () => {
    expect(
      sliceByLocation('abcdef', { start: { line: 1, column: 2 }, end: { line: 1, column: 5 } })
    ).toBe('bcd');
  });

  it('cuts a range that spans lines, keeping the lines in between', () => {
    expect(
      sliceByLocation('one\ntwo\nthree\nfour', {
        start: { line: 1, column: 3 },
        end: { line: 3, column: 4 },
      })
    ).toBe('e\ntwo\nthr');
  });

  it('cuts a range that spans exactly two lines', () => {
    expect(
      sliceByLocation('one\ntwo', { start: { line: 1, column: 2 }, end: { line: 2, column: 2 } })
    ).toBe('ne\nt');
  });

  it('accepts a range that starts at column 1 and one that ends at column 1 of a later line', () => {
    expect(
      sliceByLocation('abc', { start: { line: 1, column: 1 }, end: { line: 1, column: 3 } })
    ).toBe('ab');
    expect(
      sliceByLocation('one\ntwo', { start: { line: 1, column: 2 }, end: { line: 2, column: 1 } })
    ).toBe('ne\n');
  });

  it('returns null for a multi-line range that ends at column 0', () => {
    expect(
      sliceByLocation('one\ntwo', { start: { line: 1, column: 2 }, end: { line: 2, column: 0 } })
    ).toBeNull();
  });

  it('returns an empty string for an empty range', () => {
    expect(
      sliceByLocation('abc', { start: { line: 1, column: 2 }, end: { line: 1, column: 2 } })
    ).toBe('');
  });

  it.each([
    [
      'start line after the last line',
      { start: { line: 2, column: 1 }, end: { line: 2, column: 2 } },
    ],
    [
      'end line after the last line',
      { start: { line: 1, column: 1 }, end: { line: 2, column: 1 } },
    ],
    ['line 0', { start: { line: 0, column: 1 }, end: { line: 1, column: 2 } }],
    ['start column 0', { start: { line: 1, column: 0 }, end: { line: 1, column: 2 } }],
    ['end column 0', { start: { line: 1, column: 1 }, end: { line: 1, column: 0 } }],
    [
      'end before start on one line',
      { start: { line: 1, column: 3 }, end: { line: 1, column: 2 } },
    ],
  ])('returns null for %s', (_name, location) => {
    expect(sliceByLocation('abc', location)).toBeNull();
  });

  it('returns null when the end line is before the start line', () => {
    expect(
      sliceByLocation('abc\ndef', { start: { line: 2, column: 1 }, end: { line: 1, column: 2 } })
    ).toBeNull();
  });
});

describe('normalizeCode', () => {
  it('collapses every run of whitespace to one space and trims', () => {
    expect(normalizeCode('  a  >=\n\t 18 ')).toBe('a >= 18');
  });
});

describe('judgeMutationReport: status handling', () => {
  it('passes when every mutant is killed', () => {
    const verdict = judge([firstComparison('Killed'), yesLiteral('Killed')]);
    expect(verdict.violations).toEqual([]);
    expect(verdict.survivors).toEqual([]);
    expect(verdict.summary).toEqual({
      total: 2,
      detected: 2,
      timeout: 0,
      allowed: 0,
      notEvaluable: 0,
      unallowed: 0,
      expectedTimeout: 0,
    });
  });

  it('counts Timeout as detected, and separately as a timeout', () => {
    const verdict = judgeMutationReport({
      gates: [gate()],
      report: {
        files: {
          [GATE_PATH]: {
            source: SOURCE,
            mutants: [
              firstComparison('Timeout'),
              yesLiteral('Killed'),
              secondComparison('Timeout'),
            ],
          },
        },
      },
      readSource: () => SOURCE,
      maxTimeouts: 2,
    });
    expect(verdict.violations).toEqual([]);
    expect(verdict.summary).toEqual({
      total: 3,
      detected: 3,
      timeout: 2,
      allowed: 0,
      notEvaluable: 0,
      unallowed: 0,
      expectedTimeout: 0,
    });
  });

  it.each(['Survived', 'NoCoverage'])('reports a %s mutant without an allowance', (status) => {
    const verdict = judge([firstComparison(status), yesLiteral('Killed')]);
    expect(verdict.summary).toEqual({
      total: 2,
      detected: 1,
      timeout: 0,
      allowed: 0,
      notEvaluable: 0,
      unallowed: 1,
      expectedTimeout: 0,
    });
    expect(verdict.survivors).toEqual([
      {
        file: GATE_PATH,
        line: 1,
        column: 41,
        status,
        mutator: 'EqualityOperator',
        original: 'age >= 18',
        replacement: 'age > 18',
        occurrence: 1,
        sameKeyCount: 1,
        allowance: {
          mutator: 'EqualityOperator',
          original: 'age >= 18',
          replacement: 'age > 18',
          reason: '',
        },
      },
    ]);
  });

  it.each(['RuntimeError', 'CompileError'])(
    'counts %s as not evaluable without failing',
    (status) => {
      const verdict = judge([firstComparison(status), yesLiteral('Killed')]);
      expect(verdict.violations).toEqual([]);
      expect(verdict.survivors).toEqual([]);
      expect(verdict.summary).toEqual({
        total: 2,
        detected: 1,
        timeout: 0,
        allowed: 0,
        notEvaluable: 1,
        unallowed: 0,
        expectedTimeout: 0,
      });
    }
  );

  it('fails on an Ignored mutant and says why', () => {
    const verdict = judge([firstComparison('Ignored'), yesLiteral('Killed')]);
    expect(verdict.violations).toEqual([
      {
        file: GATE_PATH,
        line: 1,
        message:
          'a EqualityOperator mutant was ignored. Taking mutants out with Stryker comments or mutator exclusions is not allowed',
      },
    ]);
    expect(verdict.summary.total).toBe(2);
  });

  it.each(['Pending', 'SomethingNew'])('fails on a mutant with status %s', (status) => {
    const verdict = judge([firstComparison(status), yesLiteral('Killed')]);
    expect(verdict.violations).toEqual([
      {
        file: GATE_PATH,
        line: 1,
        message: `a EqualityOperator mutant was not evaluated (status: ${status})`,
      },
    ]);
  });
});

describe('judgeMutationReport: allow list', () => {
  it('passes a survivor that an allowance matches', () => {
    const verdict = judge([firstComparison('Survived'), yesLiteral('Killed')], [allowance()]);
    expect(verdict.violations).toEqual([]);
    expect(verdict.survivors).toEqual([]);
    expect(verdict.summary).toEqual({
      total: 2,
      detected: 1,
      timeout: 0,
      allowed: 1,
      notEvaluable: 0,
      unallowed: 0,
      expectedTimeout: 0,
    });
  });

  it('passes a NoCoverage mutant that an allowance matches', () => {
    const verdict = judge([firstComparison('NoCoverage')], [allowance()]);
    expect(verdict.violations).toEqual([]);
    expect(verdict.summary.allowed).toBe(1);
  });

  it('matches regardless of whitespace differences in original and replacement', () => {
    const verdict = judge(
      [firstComparison('Survived', 'age  >  18')],
      [allowance({ original: ' age\n  >=   18 ', replacement: 'age >\t18' })]
    );
    expect(verdict.violations).toEqual([]);
    expect(verdict.summary.allowed).toBe(1);
  });

  it('takes the original from the source, not from the allowance or a line number', () => {
    // Same mutator and replacement, but the allowance names different original code.
    const verdict = judge([firstComparison('Survived')], [allowance({ original: 'age >= 21' })]);
    expect(verdict.survivors).toHaveLength(1);
    expect(verdict.violations).toHaveLength(1);
    expect(verdict.violations[0]?.message).toContain(
      'stale allowance (no such mutant in this run)'
    );
  });

  it.each([
    ['mutator', { mutator: 'ConditionalExpression' }],
    ['replacement', { replacement: 'age < 18' }],
  ])('does not match when the %s differs', (_field, overrides) => {
    const verdict = judge([firstComparison('Survived')], [allowance(overrides)]);
    expect(verdict.survivors).toHaveLength(1);
    expect(verdict.summary.allowed).toBe(0);
  });

  it('does not let one allowance cover a different mutant on the same line', () => {
    const other = mutant('Survived', 'ConditionalExpression', 'true', 1, 41, 50);
    const verdict = judge([firstComparison('Survived'), other], [allowance()]);
    expect(verdict.summary).toMatchObject({ allowed: 1, unallowed: 1 });
    expect(verdict.survivors.map((survivor) => survivor.mutator)).toEqual([
      'ConditionalExpression',
    ]);
  });

  it('fails on a stale allowance whose mutant is now killed', () => {
    const verdict = judge([firstComparison('Killed')], [allowance()]);
    expect(verdict.violations).toEqual([
      {
        file: 'test-gates.json',
        message:
          'src/age.ts: equivalentMutants[0] (EqualityOperator / age >= 18 → age > 18): stale allowance (the mutant is now Killed). Remove it',
      },
    ]);
    expect(verdict.summary.allowed).toBe(0);
  });

  it('fails on a stale allowance whose mutant no longer exists', () => {
    const verdict = judge([yesLiteral('Killed')], [allowance()]);
    expect(verdict.violations).toEqual([
      {
        file: 'test-gates.json',
        message:
          'src/age.ts: equivalentMutants[0] (EqualityOperator / age >= 18 → age > 18): stale allowance (no such mutant in this run). Remove it',
      },
    ]);
  });

  it('fails when two allowances point at the same mutant', () => {
    const verdict = judge([firstComparison('Survived')], [allowance(), allowance()]);
    expect(verdict.violations).toEqual([
      {
        file: 'test-gates.json',
        message:
          'src/age.ts: equivalentMutants[1] (EqualityOperator / age >= 18 → age > 18): another allowance already covers this mutant',
      },
    ]);
    expect(verdict.summary.allowed).toBe(1);
  });

  it('fails when the reason is missing, and does not apply that allowance', () => {
    const verdict = judge([firstComparison('Survived')], [allowance({ reason: '  ' })]);
    expect(verdict.violations).toEqual([
      {
        file: 'test-gates.json',
        message:
          'src/age.ts: equivalentMutants[0]: "reason" is missing (say why the mutant cannot be observed)',
      },
    ]);
    expect(verdict.summary).toMatchObject({ allowed: 0, unallowed: 1 });
  });

  it('fails when equivalentMutants is not an array', () => {
    const verdict = judgeMutationReport({
      gates: [{ ...gate(), equivalentMutants: {} as unknown as EquivalentMutant[] }],
      report: { files: { [GATE_PATH]: { source: SOURCE, mutants: [firstComparison('Killed')] } } },
      readSource: () => SOURCE,
    });
    expect(verdict.violations).toEqual([
      { file: 'test-gates.json', message: 'src/age.ts: equivalentMutants must be an array' },
    ]);
  });

  it('accepts an empty replacement in an allowance', () => {
    const emptied = mutant('Survived', 'StringLiteral', '', 2, 45, 50);
    const verdict = judge(
      [emptied],
      [allowance({ mutator: 'StringLiteral', original: '"yes"', replacement: '' })]
    );
    expect(verdict.violations).toEqual([]);
    expect(verdict.summary.allowed).toBe(1);
  });

  it('treats a mutant without a replacement field as an empty replacement', () => {
    const noReplacement: ReportMutant = {
      status: 'Survived',
      mutatorName: 'StringLiteral',
      location: { start: { line: 2, column: 45 }, end: { line: 2, column: 50 } },
    };
    const verdict = judge([noReplacement]);
    expect(verdict.survivors[0]?.replacement).toBe('');
  });
});

describe('judgeMutationReport: occurrence', () => {
  it('numbers identical mutants in source order, whatever the report order', () => {
    const verdict = judge([secondComparison('Survived'), firstComparison('Survived')]);
    expect(
      verdict.survivors.map(({ line, occurrence, sameKeyCount, allowance: entry }) => ({
        line,
        occurrence,
        sameKeyCount,
        allowedOccurrence: entry.occurrence,
      }))
    ).toEqual([
      { line: 1, occurrence: 1, sameKeyCount: 2, allowedOccurrence: 1 },
      { line: 3, occurrence: 2, sameKeyCount: 2, allowedOccurrence: 2 },
    ]);
  });

  it('orders mutants on the same line by column', () => {
    const source = 'export const f = (a: number) => a >= 18 || a >= 18;\n';
    const left = mutant('Survived', 'EqualityOperator', 'a > 18', 1, 33, 40);
    const right = mutant('Killed', 'EqualityOperator', 'a > 18', 1, 44, 51);
    const verdict = judgeMutationReport({
      gates: [
        gate([
          {
            mutator: 'EqualityOperator',
            original: 'a >= 18',
            replacement: 'a > 18',
            occurrence: 1,
            reason: 'documented reason',
          },
        ]),
      ],
      report: { files: { [GATE_PATH]: { source, mutants: [right, left] } } },
      readSource: () => source,
    });
    expect(verdict.violations).toEqual([]);
    expect(verdict.summary).toMatchObject({ allowed: 1, detected: 1 });
  });

  it('fails when an allowance without occurrence matches several mutants, even if one was killed', () => {
    const verdict = judge([firstComparison('Survived'), secondComparison('Killed')], [allowance()]);
    expect(verdict.violations).toEqual([
      {
        file: 'test-gates.json',
        message:
          'src/age.ts: equivalentMutants[0] (EqualityOperator / age >= 18 → age > 18): matches 2 mutants in the file. Add "occurrence" (1-based) to pick one',
      },
    ]);
    expect(verdict.summary).toMatchObject({ allowed: 0, unallowed: 1 });
  });

  it('allows only the mutant that occurrence points at', () => {
    const verdict = judge(
      [firstComparison('Survived'), secondComparison('Survived')],
      [allowance({ occurrence: 2 })]
    );
    expect(verdict.violations).toEqual([]);
    expect(verdict.summary).toMatchObject({ allowed: 1, unallowed: 1 });
    expect(verdict.survivors.map((survivor) => survivor.line)).toEqual([1]);
  });

  it('fails when occurrence points at a killed mutant', () => {
    const verdict = judge(
      [firstComparison('Killed'), secondComparison('Survived')],
      [allowance({ occurrence: 1 })]
    );
    expect(verdict.violations.map((violation) => violation.message)).toEqual([
      'src/age.ts: equivalentMutants[0] (EqualityOperator / age >= 18 → age > 18 / occurrence 1): stale allowance (the mutant is now Killed). Remove it',
    ]);
    expect(verdict.survivors.map((survivor) => survivor.line)).toEqual([3]);
  });

  it('fails when occurrence is beyond the number of identical mutants', () => {
    const verdict = judge([firstComparison('Survived')], [allowance({ occurrence: 2 })]);
    expect(verdict.violations.map((violation) => violation.message)).toEqual([
      'src/age.ts: equivalentMutants[0] (EqualityOperator / age >= 18 → age > 18 / occurrence 2): stale allowance (no such mutant in this run). Remove it',
    ]);
  });

  it('accepts occurrence 1 for a mutant that is unique', () => {
    const verdict = judge([firstComparison('Survived')], [allowance({ occurrence: 1 })]);
    expect(verdict.violations).toEqual([]);
    expect(verdict.summary.allowed).toBe(1);
  });

  it.each([0, -1, 1.5, '1'])('rejects occurrence %j', (occurrence) => {
    const verdict = judge(
      [firstComparison('Survived')],
      [allowance({ occurrence: occurrence as number })]
    );
    expect(verdict.violations).toEqual([
      {
        file: 'test-gates.json',
        message: 'src/age.ts: equivalentMutants[0]: "occurrence" must be an integer >= 1',
      },
    ]);
    expect(verdict.summary.allowed).toBe(0);
  });
});

describe('judgeMutationReport: the report itself', () => {
  it('fails when a gate is absent from the report', () => {
    const verdict = judgeMutationReport({
      gates: [gate(), { path: 'src/other.ts', decides: 'd', impact: 'i' }],
      report: { files: { [GATE_PATH]: { source: SOURCE, mutants: [firstComparison('Killed')] } } },
      readSource: () => SOURCE,
    });
    expect(verdict.violations).toEqual([
      {
        file: 'src/other.ts',
        message: 'no mutants in the report (the gate was not mutation tested)',
      },
    ]);
    expect(verdict.summary.total).toBe(1);
  });

  it.each([
    ['an empty mutant list', { source: SOURCE, mutants: [] }],
    ['no mutant list', { source: SOURCE }],
  ])('fails when a gate has %s', (_name, file) => {
    const verdict = judgeMutationReport({
      gates: [gate()],
      report: { files: { [GATE_PATH]: file } },
      readSource: () => SOURCE,
    });
    expect(verdict.violations).toEqual([
      { file: GATE_PATH, message: 'no mutants in the report (the gate was not mutation tested)' },
      {
        file: 'test-gates.json',
        message: 'no mutants were evaluated (the mutation test ran on nothing)',
      },
    ]);
  });

  it.each([
    ['an empty report', {}],
    ['a report with no files', { files: {} }],
  ])('fails on %s', (_name, report) => {
    const verdict = judgeMutationReport({ gates: [gate()], report, readSource: () => SOURCE });
    expect(verdict.violations.map((violation) => violation.message)).toEqual([
      'no mutants in the report (the gate was not mutation tested)',
      'no mutants were evaluated (the mutation test ran on nothing)',
    ]);
  });

  it('fails when there are no gates at all', () => {
    const verdict = judgeMutationReport({ gates: [], report: {}, readSource: () => undefined });
    expect(verdict.violations).toEqual([
      {
        file: 'test-gates.json',
        message: 'no mutants were evaluated (the mutation test ran on nothing)',
      },
    ]);
  });

  it('ignores report files that are not gates', () => {
    const verdict = judgeMutationReport({
      gates: [gate()],
      report: {
        files: {
          [GATE_PATH]: { source: SOURCE, mutants: [firstComparison('Killed')] },
          'src/not-a-gate.ts': { source: SOURCE, mutants: [firstComparison('Survived')] },
        },
      },
      readSource: () => SOURCE,
    });
    expect(verdict.violations).toEqual([]);
    expect(verdict.summary.total).toBe(1);
  });

  it.each([
    ['a ./ prefix in the report', './src/age.ts', GATE_PATH],
    ['backslashes in the report', 'src\\age.ts', GATE_PATH],
    ['a ./ prefix in the gate', GATE_PATH, './src/age.ts'],
  ])('finds the gate despite %s', (_name, reportKey, gatePath) => {
    const verdict = judgeMutationReport({
      gates: [{ ...gate(), path: gatePath }],
      report: { files: { [reportKey]: { source: SOURCE, mutants: [firstComparison('Killed')] } } },
      readSource: () => SOURCE,
    });
    expect(verdict.violations).toEqual([]);
    expect(verdict.summary.detected).toBe(1);
  });

  it('drops only a leading ./ when comparing paths', () => {
    const verdict = judgeMutationReport({
      gates: [gate()],
      report: {
        files: { 'src/./age.ts': { source: SOURCE, mutants: [firstComparison('Killed')] } },
      },
      readSource: () => SOURCE,
    });
    expect(verdict.violations[0]).toEqual({
      file: GATE_PATH,
      message: 'no mutants in the report (the gate was not mutation tested)',
    });
  });

  it('reads the source from disk when the report has none', () => {
    const verdict = judgeMutationReport({
      gates: [gate([allowance()])],
      report: { files: { [GATE_PATH]: { mutants: [firstComparison('Survived')] } } },
      readSource: (gatePath) => (gatePath === GATE_PATH ? SOURCE : undefined),
    });
    expect(verdict.violations).toEqual([]);
    expect(verdict.summary.allowed).toBe(1);
  });

  it('uses the source of the report when the file cannot be read from disk', () => {
    const verdict = judgeMutationReport({
      gates: [gate([allowance()])],
      report: {
        files: { [GATE_PATH]: { source: SOURCE, mutants: [firstComparison('Survived')] } },
      },
      readSource: () => undefined,
    });
    expect(verdict.violations).toEqual([]);
    expect(verdict.summary.allowed).toBe(1);
  });

  it('fails when the source is available nowhere', () => {
    const verdict = judgeMutationReport({
      gates: [gate()],
      report: { files: { [GATE_PATH]: { mutants: [firstComparison('Killed')] } } },
      readSource: () => undefined,
    });
    expect(verdict.violations[0]).toEqual({
      file: GATE_PATH,
      message: 'source is neither in the report nor readable on disk',
    });
    expect(verdict.summary.total).toBe(0);
  });

  it('fails when the report was made from a different version of the file', () => {
    const verdict = judgeMutationReport({
      gates: [gate()],
      report: { files: { [GATE_PATH]: { source: SOURCE, mutants: [firstComparison('Killed')] } } },
      readSource: () => SOURCE.replace('18', '20'),
    });
    expect(verdict.violations[0]).toEqual({
      file: GATE_PATH,
      message: 'the report was made from a different version of this file. Run Stryker again',
    });
    expect(verdict.summary.total).toBe(0);
  });

  it('does not treat CRLF versus LF as a different version, and slices CRLF sources correctly', () => {
    const crlf = SOURCE.replace(/\n/g, '\r\n');
    const multiLine = mutant('Survived', 'ArrowFunction', '() => undefined', 1, 24, 50);
    const twoLines: ReportMutant = {
      ...multiLine,
      location: { start: { line: 1, column: 41 }, end: { line: 2, column: 7 } },
    };
    const verdict = judgeMutationReport({
      gates: [gate()],
      report: { files: { [GATE_PATH]: { source: crlf, mutants: [twoLines] } } },
      readSource: () => SOURCE,
    });
    expect(verdict.violations).toEqual([]);
    expect(verdict.survivors[0]?.original).toBe('age >= 18; export');
  });

  it('fails when a location is outside the source, without judging the file', () => {
    const outside = mutant('Survived', 'EqualityOperator', 'x', 99, 1, 2);
    const verdict = judge([firstComparison('Killed'), outside]);
    expect(verdict.violations).toEqual([
      {
        file: GATE_PATH,
        line: 99,
        message: 'the report location of a EqualityOperator mutant is outside the source',
      },
      {
        file: 'test-gates.json',
        message: 'no mutants were evaluated (the mutation test ran on nothing)',
      },
    ]);
  });

  it('sums over several gates', () => {
    const verdict = judgeMutationReport({
      gates: [gate(), { path: 'src/b.ts', decides: 'd', impact: 'i' }],
      report: {
        files: {
          [GATE_PATH]: { source: SOURCE, mutants: [firstComparison('Killed')] },
          'src/b.ts': { source: SOURCE, mutants: [yesLiteral('Survived'), yesLiteral('Timeout')] },
        },
      },
      readSource: () => SOURCE,
    });
    expect(verdict.summary).toEqual({
      total: 3,
      detected: 2,
      timeout: 1,
      allowed: 0,
      notEvaluable: 0,
      unallowed: 1,
      expectedTimeout: 0,
    });
    expect(verdict.survivors.map((survivor) => survivor.file)).toEqual(['src/b.ts']);
  });
});

describe('formatting', () => {
  it('prints a survivor as file:line:column / mutator / original → replacement', () => {
    const [survivor] = judge([firstComparison('Survived')]).survivors;
    expect(formatSurvivor(survivor!)).toBe(
      'src/age.ts:1:41 / EqualityOperator / age >= 18 → age > 18 (Survived)'
    );
  });

  it('adds the occurrence when the same mutant exists more than once', () => {
    const { survivors } = judge([firstComparison('Killed'), secondComparison('NoCoverage')]);
    expect(formatSurvivor(survivors[0]!)).toBe(
      'src/age.ts:3:42 / EqualityOperator / age >= 18 → age > 18 / occurrence 2 of 2 (NoCoverage)'
    );
    expect(survivors[0]?.allowance).toEqual({
      mutator: 'EqualityOperator',
      original: 'age >= 18',
      replacement: 'age > 18',
      occurrence: 2,
      reason: '',
    });
  });

  it('prints the real numbers on one line', () => {
    expect(
      formatSummary({
        total: 120,
        detected: 110,
        timeout: 4,
        allowed: 6,
        notEvaluable: 3,
        unallowed: 1,
        expectedTimeout: 0,
      })
    ).toBe(
      'mutants 120 / detected 110 (timeout 4) / allowed equivalent 6 / not evaluable 3 / unallowed survivors 1'
    );
  });
});

describe('judgeMutationReport: timeouts', () => {
  const expectedTimeout = (overrides: Partial<EquivalentMutant> = {}): EquivalentMutant =>
    allowance({ reason: 'the loop never ends, so the run always times out', ...overrides });

  function judgeTimeouts(
    mutants: ReportMutant[],
    options: { expectedTimeouts?: EquivalentMutant[]; maxTimeouts?: number } = {}
  ) {
    return judgeMutationReport({
      gates: [
        {
          ...gate(),
          ...(options.expectedTimeouts ? { expectedTimeouts: options.expectedTimeouts } : {}),
        },
      ],
      report: { files: { [GATE_PATH]: { source: SOURCE, mutants } } },
      readSource: () => SOURCE,
      ...(options.maxTimeouts === undefined ? {} : { maxTimeouts: options.maxTimeouts }),
    });
  }

  it('fails on any timeout when no limit is given: the default is 0', () => {
    const verdict = judgeTimeouts([firstComparison('Timeout'), secondComparison('Timeout')]);
    expect(verdict.violations).toEqual([
      {
        file: 'test-gates.json',
        message:
          '2 mutant(s) timed out outside expectedTimeouts; settings.mutation.maxTimeouts allows 0',
      },
    ]);
    expect(verdict.summary).toMatchObject({ detected: 2, timeout: 2, expectedTimeout: 0 });
    expect(verdict.unexpectedTimeouts.map(({ line, status }) => [line, status])).toEqual([
      [1, 'Timeout'],
      [3, 'Timeout'],
    ]);
  });

  it('passes when the number of timeouts equals the limit', () => {
    const verdict = judgeTimeouts([firstComparison('Timeout'), yesLiteral('Timeout')], {
      maxTimeouts: 2,
    });
    expect(verdict.violations).toEqual([]);
    expect(verdict.unexpectedTimeouts).toHaveLength(2);
  });

  it('fails when the number of timeouts exceeds the limit', () => {
    const verdict = judgeTimeouts([firstComparison('Timeout'), yesLiteral('Timeout')], {
      maxTimeouts: 1,
    });
    expect(verdict.violations).toEqual([
      {
        file: 'test-gates.json',
        message:
          '2 mutant(s) timed out outside expectedTimeouts; settings.mutation.maxTimeouts allows 1',
      },
    ]);
    expect(verdict.summary).toMatchObject({ detected: 2, timeout: 2 });
  });

  it('fails on a single timeout when the limit is 0, and not on none', () => {
    expect(judgeTimeouts([firstComparison('Timeout')], { maxTimeouts: 0 }).violations).toEqual([
      {
        file: 'test-gates.json',
        message:
          '1 mutant(s) timed out outside expectedTimeouts; settings.mutation.maxTimeouts allows 0',
      },
    ]);
    expect(judgeTimeouts([firstComparison('Killed')], { maxTimeouts: 0 }).violations).toEqual([]);
  });

  it('describes an unexpected timeout with an entry that can be pasted into expectedTimeouts', () => {
    const verdict = judgeTimeouts([firstComparison('Timeout'), secondComparison('Killed')]);
    expect(verdict.unexpectedTimeouts).toEqual([
      {
        file: GATE_PATH,
        line: 1,
        column: 41,
        status: 'Timeout',
        mutator: 'EqualityOperator',
        original: 'age >= 18',
        replacement: 'age > 18',
        occurrence: 1,
        sameKeyCount: 2,
        allowance: {
          mutator: 'EqualityOperator',
          original: 'age >= 18',
          replacement: 'age > 18',
          occurrence: 1,
          reason: '',
        },
      },
    ]);
  });

  it('does not count an expected timeout against the limit', () => {
    const verdict = judgeTimeouts([firstComparison('Timeout'), yesLiteral('Timeout')], {
      maxTimeouts: 1,
      expectedTimeouts: [expectedTimeout()],
    });
    expect(verdict.violations).toEqual([]);
    expect(verdict.summary).toMatchObject({ detected: 2, timeout: 2, expectedTimeout: 1 });
    expect(verdict.unexpectedTimeouts.map((mutant) => mutant.mutator)).toEqual(['StringLiteral']);
  });

  it('accepts an expected timeout that was killed instead', () => {
    const verdict = judgeTimeouts([firstComparison('Killed')], {
      maxTimeouts: 0,
      expectedTimeouts: [expectedTimeout()],
    });
    expect(verdict.violations).toEqual([]);
    expect(verdict.summary).toMatchObject({ detected: 1, timeout: 0, expectedTimeout: 0 });
  });

  it.each([
    ['Survived', 'survived'],
    ['NoCoverage', 'has no coverage'],
  ])('fails when an expected timeout is %s', (status, wording) => {
    const verdict = judgeTimeouts([firstComparison(status)], {
      expectedTimeouts: [expectedTimeout()],
    });
    expect(verdict.violations).toEqual([
      {
        file: 'test-gates.json',
        message: `src/age.ts: expectedTimeouts[0] (EqualityOperator / age >= 18 → age > 18): the mutant ${wording} instead of timing out. Detect it with a test`,
      },
    ]);
    expect(verdict.survivors).toHaveLength(1);
  });

  it('fails on an expected timeout whose mutant does not exist', () => {
    const verdict = judgeTimeouts([yesLiteral('Killed')], {
      expectedTimeouts: [expectedTimeout()],
    });
    expect(verdict.violations).toEqual([
      {
        file: 'test-gates.json',
        message:
          'src/age.ts: expectedTimeouts[0] (EqualityOperator / age >= 18 → age > 18): stale entry (no such mutant in this run). Remove it',
      },
    ]);
  });

  it('requires occurrence when the key matches several mutants, and honours it', () => {
    const mutants = [firstComparison('Timeout'), secondComparison('Timeout')];
    expect(
      judgeTimeouts(mutants, { maxTimeouts: 0, expectedTimeouts: [expectedTimeout()] }).violations
    ).toEqual([
      {
        file: 'test-gates.json',
        message:
          'src/age.ts: expectedTimeouts[0] (EqualityOperator / age >= 18 → age > 18): matches 2 mutants in the file. Add "occurrence" (1-based) to pick one',
      },
      {
        file: 'test-gates.json',
        message:
          '2 mutant(s) timed out outside expectedTimeouts; settings.mutation.maxTimeouts allows 0',
      },
    ]);
    const picked = judgeTimeouts(mutants, {
      maxTimeouts: 1,
      expectedTimeouts: [expectedTimeout({ occurrence: 2 })],
    });
    expect(picked.violations).toEqual([]);
    expect(picked.unexpectedTimeouts.map((mutant) => mutant.line)).toEqual([1]);
  });

  it('fails when two entries point at the same mutant', () => {
    const verdict = judgeTimeouts([firstComparison('Timeout')], {
      expectedTimeouts: [expectedTimeout(), expectedTimeout()],
    });
    expect(verdict.violations).toEqual([
      {
        file: 'test-gates.json',
        message:
          'src/age.ts: expectedTimeouts[1] (EqualityOperator / age >= 18 → age > 18): another entry already covers this mutant',
      },
    ]);
    expect(verdict.summary.expectedTimeout).toBe(1);
  });

  it('requires a reason, and does not apply an entry without one', () => {
    const verdict = judgeTimeouts([firstComparison('Timeout')], {
      maxTimeouts: 0,
      expectedTimeouts: [expectedTimeout({ reason: '' })],
    });
    expect(verdict.violations.map((violation) => violation.message)).toEqual([
      'src/age.ts: expectedTimeouts[0]: "reason" is missing (say why the mutant cannot be observed)',
      '1 mutant(s) timed out outside expectedTimeouts; settings.mutation.maxTimeouts allows 0',
    ]);
  });

  it('fails when expectedTimeouts is not an array', () => {
    const verdict = judgeMutationReport({
      gates: [{ ...gate(), expectedTimeouts: 'x' as unknown as EquivalentMutant[] }],
      report: { files: { [GATE_PATH]: { source: SOURCE, mutants: [firstComparison('Timeout')] } } },
      readSource: () => SOURCE,
      maxTimeouts: 1,
    });
    expect(verdict.violations).toEqual([
      { file: 'test-gates.json', message: 'src/age.ts: expectedTimeouts must be an array' },
    ]);
    expect(verdict.unexpectedTimeouts).toHaveLength(1);
  });

  it('keeps equivalent mutants and expected timeouts apart', () => {
    // An equivalentMutants entry cannot cover a timeout, and the timeout stays unexpected.
    const verdict = judgeMutationReport({
      gates: [gate([allowance()])],
      report: { files: { [GATE_PATH]: { source: SOURCE, mutants: [firstComparison('Timeout')] } } },
      readSource: () => SOURCE,
      maxTimeouts: 0,
    });
    expect(verdict.violations.map((violation) => violation.message)).toEqual([
      'src/age.ts: equivalentMutants[0] (EqualityOperator / age >= 18 → age > 18): stale allowance (the mutant is now Timeout). Remove it',
      '1 mutant(s) timed out outside expectedTimeouts; settings.mutation.maxTimeouts allows 0',
    ]);
  });

  it('counts timeouts over all gates', () => {
    const verdict = judgeMutationReport({
      gates: [gate(), { path: 'src/b.ts', decides: 'd', impact: 'i' }],
      report: {
        files: {
          [GATE_PATH]: { source: SOURCE, mutants: [firstComparison('Timeout')] },
          'src/b.ts': { source: SOURCE, mutants: [yesLiteral('Timeout')] },
        },
      },
      readSource: () => SOURCE,
      maxTimeouts: 1,
    });
    expect(verdict.violations.map((violation) => violation.message)).toEqual([
      '2 mutant(s) timed out outside expectedTimeouts; settings.mutation.maxTimeouts allows 1',
    ]);
    expect(verdict.unexpectedTimeouts.map((mutant) => mutant.file)).toEqual([
      GATE_PATH,
      'src/b.ts',
    ]);
  });
});
