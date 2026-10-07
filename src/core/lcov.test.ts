import { describe, expect, it } from 'vitest';
import { judgeLcov, parseLcov, summarizeLcov } from './lcov';

const record = (file: string, lines: [number, number][]) =>
  [
    `SF:${file}`,
    ...lines.map(([line, hits]) => `DA:${line},${hits}`),
    `LF:${lines.length}`,
    `LH:${lines.filter(([, hits]) => hits > 0).length}`,
    'end_of_record',
  ].join('\n');

describe('parseLcov', () => {
  it('reads found, hit and uncovered lines per file', () => {
    const coverage = parseLcov(
      `${record('lib/models/coupon.dart', [
        [3, 1],
        [12, 0],
        [9, 5],
        [7, 0],
        [10, 0],
      ])}\n`
    );
    expect([...coverage.entries()]).toEqual([
      ['lib/models/coupon.dart', { found: 5, hit: 2, uncovered: [7, 10, 12] }],
    ]);
  });

  it('reads several records', () => {
    const coverage = parseLcov(
      [record('lib/a.dart', [[1, 1]]), record('lib/b.dart', [[1, 0]])].join('\n')
    );
    expect(coverage.get('lib/a.dart')).toEqual({ found: 1, hit: 1, uncovered: [] });
    expect(coverage.get('lib/b.dart')).toEqual({ found: 1, hit: 0, uncovered: [1] });
  });

  it('unites the lines of records for the same file', () => {
    const coverage = parseLcov(
      [
        record('lib/a.dart', [
          [1, 1],
          [2, 0],
        ]),
        record('lib/a.dart', [
          [1, 0],
          [2, 3],
          [3, 0],
        ]),
      ].join('\n')
    );
    expect(coverage.get('lib/a.dart')).toEqual({ found: 3, hit: 2, uncovered: [3] });
  });

  it('falls back to LF / LH for a record without DA entries', () => {
    const coverage = parseLcov('SF:lib/a.dart\nLF:10\nLH:7\nend_of_record\n');
    expect(coverage.get('lib/a.dart')).toEqual({ found: 10, hit: 7, uncovered: [] });
  });

  it('adds the LF / LH totals of DA-less records for the same file', () => {
    const coverage = parseLcov(
      'SF:lib/a.dart\nLF:10\nLH:7\nend_of_record\nSF:lib/a.dart\nLF:2\nLH:2\nend_of_record\n'
    );
    expect(coverage.get('lib/a.dart')).toEqual({ found: 12, hit: 9, uncovered: [] });
  });

  it('keeps the totals of a DA-less record that is cut short by the next SF or by the end of the file', () => {
    const coverage = parseLcov('SF:lib/a.dart\nLF:2\nLH:1\nSF:lib/b.dart\nLF:3\nLH:3');
    expect(coverage.get('lib/a.dart')).toEqual({ found: 2, hit: 1, uncovered: [] });
    expect(coverage.get('lib/b.dart')).toEqual({ found: 3, hit: 3, uncovered: [] });
  });

  it('reads LF / LH only from lines that start with LF: / LH:', () => {
    const coverage = parseLcov('SF:lib/a.dart\nLF:4\nLH:3\nBRF:0\nBRH:0\nXX:9\nend_of_record\n');
    expect(coverage.get('lib/a.dart')).toEqual({ found: 4, hit: 3, uncovered: [] });
  });

  it('does not count LF / LH twice when the record has DA entries', () => {
    const coverage = parseLcov('SF:lib/a.dart\nDA:1,1\nDA:2,0\nLF:2\nLH:1\nend_of_record\n');
    expect(coverage.get('lib/a.dart')).toEqual({ found: 2, hit: 1, uncovered: [2] });
  });

  it('handles CRLF, surrounding spaces, a missing final end_of_record and other record types', () => {
    const coverage = parseLcov(
      'TN:\r\nSF:lib/a.dart\r\nFN:1,main\r\nFNDA:1,main\r\n DA:1,2 \r\nBRDA:1,0,0,1\r\nDA:2,0,abc\r\nLF:2\r\nLH:1'
    );
    expect(coverage.get('lib/a.dart')).toEqual({ found: 2, hit: 1, uncovered: [2] });
  });

  it('ignores coverage lines outside a record and malformed DA entries', () => {
    const coverage = parseLcov(
      'DA:1,1\nLF:5\nLH:5\nSF:lib/a.dart\nDA:x,1\nDA:2,y\nDA:3,1\nend_of_record\nDA:9,0\n'
    );
    expect([...coverage.entries()]).toEqual([['lib/a.dart', { found: 1, hit: 1, uncovered: [] }]]);
  });

  it('treats non-numeric LF / LH as zero', () => {
    const coverage = parseLcov('SF:lib/a.dart\nLF:x\nLH:y\nend_of_record\n');
    expect(coverage.get('lib/a.dart')).toEqual({ found: 0, hit: 0, uncovered: [] });
  });

  it('normalizes ./ prefixes and backslashes', () => {
    const coverage = parseLcov(
      [record('./lib/a.dart', [[1, 1]]), record('lib\\b.dart', [[1, 1]])].join('\n')
    );
    expect([...coverage.keys()]).toEqual(['lib/a.dart', 'lib/b.dart']);
  });

  it('makes absolute paths under rootDir relative, and leaves others alone', () => {
    const text = [
      record('/work/app/lib/a.dart', [[1, 1]]),
      record('/work/application/lib/b.dart', [[1, 1]]),
      record('/elsewhere/lib/c.dart', [[1, 1]]),
    ].join('\n');
    expect([...parseLcov(text, '/work/app/').keys()]).toEqual([
      'lib/a.dart',
      '/work/application/lib/b.dart',
      '/elsewhere/lib/c.dart',
    ]);
    expect([...parseLcov(text, '/work/app//').keys()][0]).toBe('lib/a.dart');
    expect([...parseLcov(text, 'C:\\work\\app').keys()]).toEqual([
      '/work/app/lib/a.dart',
      '/work/application/lib/b.dart',
      '/elsewhere/lib/c.dart',
    ]);
    expect([...parseLcov(text).keys()][0]).toBe('/work/app/lib/a.dart');
  });

  it('makes Windows paths under a Windows rootDir relative', () => {
    const text = record('C:\\work\\app\\lib\\a.dart', [[1, 1]]);
    expect([...parseLcov(text, 'C:\\work\\app').keys()]).toEqual(['lib/a.dart']);
    expect([...parseLcov(text, 'C:\\work\\app\\').keys()]).toEqual(['lib/a.dart']);
  });

  it('drops only a leading ./', () => {
    const text = [record('lib/./a.dart', [[1, 1]]), record('./lib/b.dart', [[1, 1]])].join('\n');
    expect([...parseLcov(text).keys()]).toEqual(['lib/./a.dart', 'lib/b.dart']);
  });

  it('returns nothing for an empty file', () => {
    expect(parseLcov('').size).toBe(0);
  });
});

describe('judgeLcov', () => {
  // A function, not a constant: calling the gate while the file is being collected would make
  // its mutants static.
  const read = () =>
    parseLcov(
      [
        record('lib/full.dart', [
          [1, 1],
          [2, 4],
        ]),
        record('lib/partial.dart', [
          [1, 1],
          [2, 0],
          [5, 0],
        ]),
        'SF:lib/empty.dart\nLF:0\nLH:0\nend_of_record',
        'SF:lib/totals-only.dart\nLF:4\nLH:3\nend_of_record',
      ].join('\n')
    );

  it('passes a gate whose every line is hit', () => {
    expect(judgeLcov(['lib/full.dart'], read())).toEqual({
      violations: [],
      results: [{ path: 'lib/full.dart', found: 2, hit: 2, ok: true }],
    });
  });

  it('fails a gate with an uncovered line and lists the lines', () => {
    expect(judgeLcov(['lib/partial.dart'], read())).toEqual({
      violations: [
        { file: 'lib/partial.dart', line: 2, message: '1/3 lines covered (uncovered: 2, 5)' },
      ],
      results: [{ path: 'lib/partial.dart', found: 3, hit: 1, ok: false }],
    });
  });

  it('fails a gate that has no record', () => {
    expect(judgeLcov(['lib/missing.dart'], read())).toEqual({
      violations: [{ file: 'lib/missing.dart', message: 'no record in the lcov file' }],
      results: [{ path: 'lib/missing.dart', found: 0, hit: 0, ok: false }],
    });
  });

  it('fails a gate whose record has no instrumented line', () => {
    expect(judgeLcov(['lib/empty.dart'], read())).toEqual({
      violations: [{ file: 'lib/empty.dart', message: 'no instrumented lines in the lcov record' }],
      results: [{ path: 'lib/empty.dart', found: 0, hit: 0, ok: false }],
    });
  });

  it('fails on totals alone when the record has no line data', () => {
    expect(judgeLcov(['lib/totals-only.dart'], read()).violations).toStrictEqual([
      { file: 'lib/totals-only.dart', message: '3/4 lines covered' },
    ]);
  });

  it('does not match a record by suffix or by case', () => {
    const other = parseLcov(
      [record('packages/x/lib/full.dart', [[1, 1]]), record('lib/Full.dart', [[1, 1]])].join('\n')
    );
    expect(judgeLcov(['lib/full.dart'], other).violations).toEqual([
      { file: 'lib/full.dart', message: 'no record in the lcov file' },
    ]);
  });

  it('accepts a gate path written with ./', () => {
    expect(judgeLcov(['./lib/full.dart'], read()).violations).toEqual([]);
  });

  it('judges every gate and keeps their order', () => {
    const verdict = judgeLcov(['lib/partial.dart', 'lib/full.dart', 'lib/missing.dart'], read());
    expect(verdict.results.map((result) => [result.path, result.ok])).toEqual([
      ['lib/partial.dart', false],
      ['lib/full.dart', true],
      ['lib/missing.dart', false],
    ]);
    expect(verdict.violations).toHaveLength(2);
  });

  it('shows at most 20 uncovered lines', () => {
    const lines: [number, number][] = Array.from({ length: 22 }, (_, index) => [index + 1, 0]);
    const many = parseLcov(record('lib/a.dart', [...lines, [100, 1]]));
    expect(judgeLcov(['lib/a.dart'], many).violations[0]?.message).toBe(
      '1/23 lines covered (uncovered: 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, …)'
    );
    const twenty = parseLcov(record('lib/a.dart', [...lines.slice(0, 20), [100, 1]]));
    expect(judgeLcov(['lib/a.dart'], twenty).violations[0]?.message).toBe(
      '1/21 lines covered (uncovered: 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20)'
    );
  });
});

describe('summarizeLcov', () => {
  const read = () =>
    parseLcov(
      [
        record('lib/a.dart', [
          [1, 1],
          [2, 0],
        ]),
        record('lib/a.g.dart', [[1, 0]]),
        record('lib/l10n/x.dart', [[1, 1]]),
      ].join('\n')
    );

  it('sums every record', () => {
    expect(summarizeLcov(read(), [])).toEqual({ found: 4, hit: 2 });
  });

  it('leaves out the records that match an exclude pattern', () => {
    expect(summarizeLcov(read(), [/\.g\.dart$/, /lib\/l10n\//])).toEqual({ found: 2, hit: 1 });
  });
});
