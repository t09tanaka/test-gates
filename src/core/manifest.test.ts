import { describe, expect, it } from 'vitest';
import {
  isUsableEquivalentMutant,
  ManifestError,
  parseManifest,
  validateEquivalentMutants,
} from './manifest';

const gate = { path: 'src/money.ts', decides: 'rounding', impact: 'wrong invoices' };
const candidate = { path: 'src/admin.guard.ts', decides: 'admin role', blocker: 'has decorators' };
const allowance = {
  mutator: 'ConditionalExpression',
  original: 'a.length !== b.length',
  replacement: 'false',
  reason: 'timingSafeEqual throws on a length mismatch, which is caught and returns false',
};

const parse = (value: unknown) => parseManifest(JSON.stringify(value));
const messages = (value: unknown) => parse(value).violations.map((violation) => violation.message);

describe('parseManifest: unusable files', () => {
  it.each([
    ['broken JSON', '{ "gates": [', /^test-gates\.json is not valid JSON: /],
    ['an array', '[]', /^test-gates\.json must be a JSON object$/],
    ['null', 'null', /^test-gates\.json must be a JSON object$/],
    ['no gates', '{"candidates":[]}', /^test-gates\.json: "gates" must be an array$/],
    ['gates as an object', '{"gates":{}}', /^test-gates\.json: "gates" must be an array$/],
    [
      'candidates as a string',
      '{"gates":[],"candidates":"x"}',
      /^test-gates\.json: "candidates" must be an array$/,
    ],
    [
      'an unknown top-level key',
      '{"gates":[],"gate":[]}',
      /^test-gates\.json: unknown top-level key "gate"$/,
    ],
  ])('throws ManifestError for %s', (_name, text, expected) => {
    expect(() => parseManifest(text)).toThrow(ManifestError);
    expect(() => parseManifest(text)).toThrow(expected);
  });
});

describe('parseManifest: entries', () => {
  it('accepts a complete manifest', () => {
    const settings = { spec: { suffixes: ['.spec.ts'] } };
    expect(
      parse({
        $schema: './node_modules/@t09tanaka/test-gates/schema/test-gates.schema.json',
        gates: [{ ...gate, equivalentMutants: [allowance] }],
        candidates: [candidate],
        settings,
      })
    ).toEqual({
      gates: [{ ...gate, equivalentMutants: [allowance] }],
      candidates: [candidate],
      settings,
      violations: [],
    });
  });

  it('accepts a manifest without candidates and without settings', () => {
    expect(parse({ gates: [gate] })).toEqual({
      gates: [gate],
      candidates: [],
      settings: undefined,
      violations: [],
    });
  });

  it('reports an empty gate list', () => {
    expect(parse({ gates: [], candidates: [] }).violations).toEqual([
      {
        file: 'test-gates.json',
        message: 'gates is empty. A project with nothing to gate should not have this file',
      },
    ]);
  });

  it.each([
    ['a string', 'src/money.ts', 'gates[0] must be an object'],
    ['null', null, 'gates[0] must be an object'],
    ['an array', [], 'gates[0] must be an object'],
    ['an entry without path', { decides: 'd', impact: 'i' }, 'gates[0]: "path" is missing'],
    ['an entry with a blank path', { ...gate, path: ' ' }, 'gates[0]: "path" is missing'],
    ['an entry with a numeric path', { ...gate, path: 1 }, 'gates[0]: "path" is missing'],
  ])('reports and drops a gate that is %s', (_name, entry, expected) => {
    const parsed = parse({ gates: [entry, gate], candidates: [] });
    expect(parsed.violations.map((violation) => violation.message)).toEqual([expected]);
    expect(parsed.gates).toEqual([gate]);
  });

  it.each(['decides', 'impact'])('reports a gate without %s but keeps it', (field) => {
    const entry = { ...gate, [field]: '' };
    const parsed = parse({ gates: [entry], candidates: [] });
    expect(parsed.violations).toEqual([
      { file: 'test-gates.json', message: `src/money.ts: "${field}" is missing in gates` },
    ]);
    expect(parsed.gates).toEqual([entry]);
  });

  it.each(['decides', 'blocker'])('reports a candidate without %s', (field) => {
    const rest: Record<string, string> = { ...candidate };
    delete rest[field];
    expect(messages({ gates: [gate], candidates: [rest] })).toEqual([
      `src/admin.guard.ts: "${field}" is missing in candidates`,
    ]);
  });

  it('does not require "impact" of a candidate or "blocker" of a gate', () => {
    expect(messages({ gates: [gate], candidates: [candidate] })).toEqual([]);
  });

  it('reports a gate listed twice and keeps the first', () => {
    const parsed = parse({ gates: [gate, { ...gate, decides: 'other' }], candidates: [] });
    expect(parsed.violations.map((violation) => violation.message)).toEqual([
      'src/money.ts: listed twice in gates',
    ]);
    expect(parsed.gates).toEqual([gate]);
  });

  it('reports a candidate listed twice', () => {
    expect(messages({ gates: [gate], candidates: [candidate, candidate] })).toEqual([
      'src/admin.guard.ts: listed twice in candidates',
    ]);
  });

  it('reports a path that is both a gate and a candidate', () => {
    expect(
      messages({ gates: [gate], candidates: [{ ...candidate, path: 'src/money.ts' }] })
    ).toEqual(['src/money.ts: listed in both gates and candidates']);
  });

  it('reports a candidate entry that is not an object', () => {
    expect(messages({ gates: [gate], candidates: ['x'] })).toEqual([
      'candidates[0] must be an object',
    ]);
  });

  it('reports problems of the allow list of each gate', () => {
    const noReason: Record<string, string> = { ...allowance };
    delete noReason.reason;
    expect(
      messages({ gates: [{ ...gate, equivalentMutants: [allowance, noReason] }], candidates: [] })
    ).toEqual([
      'src/money.ts: equivalentMutants[1]: "reason" is missing (say why the mutant cannot be observed)',
    ]);
  });
});

describe('expectedTimeouts', () => {
  it('is validated like equivalentMutants, under its own name', () => {
    const noReason: Record<string, string> = { ...allowance };
    delete noReason.reason;
    expect(
      messages({ gates: [{ ...gate, expectedTimeouts: [allowance, noReason] }], candidates: [] })
    ).toEqual([
      'src/money.ts: expectedTimeouts[1]: "reason" is missing (say why the mutant cannot be observed)',
    ]);
    expect(messages({ gates: [{ ...gate, expectedTimeouts: {} }], candidates: [] })).toEqual([
      'src/money.ts: expectedTimeouts must be an array',
    ]);
    expect(validateEquivalentMutants('src/a.ts', [null], 'expectedTimeouts')).toEqual([
      { file: 'test-gates.json', message: 'src/a.ts: expectedTimeouts[0] must be an object' },
    ]);
  });
});

describe('validateEquivalentMutants', () => {
  const check = (entry: unknown) =>
    validateEquivalentMutants('src/a.ts', [entry]).map((violation) => violation.message);

  it('accepts undefined, an empty list and a complete entry', () => {
    expect(validateEquivalentMutants('src/a.ts', undefined)).toEqual([]);
    expect(validateEquivalentMutants('src/a.ts', [])).toEqual([]);
    expect(check(allowance)).toEqual([]);
    expect(check({ ...allowance, occurrence: 1 })).toEqual([]);
    expect(check({ ...allowance, occurrence: 12 })).toEqual([]);
  });

  it.each([{}, 'x', null, 3])('rejects a list that is %j', (value) => {
    expect(validateEquivalentMutants('src/a.ts', value)).toEqual([
      { file: 'test-gates.json', message: 'src/a.ts: equivalentMutants must be an array' },
    ]);
  });

  it.each(['x', null, 3, []])('rejects an entry that is %j', (entry) => {
    expect(check(entry)).toEqual(['src/a.ts: equivalentMutants[0] must be an object']);
  });

  it.each([
    ['mutator', undefined],
    ['mutator', ''],
    ['mutator', '  '],
    ['mutator', 5],
    ['original', undefined],
    ['original', ' '],
    ['replacement', undefined],
    ['replacement', 0],
  ])('rejects an entry whose %s is %j', (field, value) => {
    expect(check({ ...allowance, [field]: value })).toEqual([
      `src/a.ts: equivalentMutants[0]: "${field}" is missing`,
    ]);
  });

  it('accepts an empty replacement (a string literal mutated to "")', () => {
    expect(check({ ...allowance, replacement: '' })).toEqual([]);
  });

  it.each([undefined, '', '   ', 7])('rejects a reason that is %j', (reason) => {
    expect(check({ ...allowance, reason })).toEqual([
      'src/a.ts: equivalentMutants[0]: "reason" is missing (say why the mutant cannot be observed)',
    ]);
  });

  it.each([0, -1, 1.5, '1', null])('rejects occurrence %j', (occurrence) => {
    expect(check({ ...allowance, occurrence })).toEqual([
      'src/a.ts: equivalentMutants[0]: "occurrence" must be an integer >= 1',
    ]);
  });

  it('reports every problem of every entry, with its index', () => {
    expect(
      validateEquivalentMutants('src/a.ts', [allowance, {}]).map((violation) => violation.message)
    ).toEqual([
      'src/a.ts: equivalentMutants[1]: "mutator" is missing',
      'src/a.ts: equivalentMutants[1]: "original" is missing',
      'src/a.ts: equivalentMutants[1]: "replacement" is missing',
      'src/a.ts: equivalentMutants[1]: "reason" is missing (say why the mutant cannot be observed)',
    ]);
  });

  it('isUsableEquivalentMutant mirrors the validation', () => {
    expect(isUsableEquivalentMutant(allowance)).toBe(true);
    expect(isUsableEquivalentMutant({ ...allowance, reason: '' })).toBe(false);
    expect(isUsableEquivalentMutant(null)).toBe(false);
  });
});
