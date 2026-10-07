import type { Candidate, EquivalentMutant, Gate, Violation } from './types.js';

export const MANIFEST_FILE = 'test-gates.json';

/** The manifest cannot be used at all (exit code 2), as opposed to a violation inside it (exit code 1). */
export class ManifestError extends Error {}

export interface ParsedManifest {
  /** Entries whose `path` is usable. Other problems of an entry are reported in `violations`. */
  gates: Gate[];
  candidates: Candidate[];
  settings: unknown;
  violations: Violation[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFilled(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/** What is wrong with one allowance. Empty when it can be used for matching. */
function allowanceProblems(entry: unknown): string[] {
  if (!isRecord(entry)) {
    return [' must be an object'];
  }
  const problems: string[] = [];
  if (!isFilled(entry.mutator)) {
    problems.push(': "mutator" is missing');
  }
  if (!isFilled(entry.original)) {
    problems.push(': "original" is missing');
  }
  // An empty replacement is real: StringLiteral mutates "abc" to "".
  if (typeof entry.replacement !== 'string') {
    problems.push(': "replacement" is missing');
  }
  if (!isFilled(entry.reason)) {
    problems.push(': "reason" is missing (say why the mutant cannot be observed)');
  }
  if (
    entry.occurrence !== undefined &&
    !(Number.isInteger(entry.occurrence) && (entry.occurrence as number) >= 1)
  ) {
    problems.push(': "occurrence" must be an integer >= 1');
  }
  return problems;
}

/**
 * Checks the allow list of one gate. `reason` is mandatory: an allowance nobody can justify
 * is a mutant nobody checked.
 */
export function validateEquivalentMutants(gatePath: string, value: unknown): Violation[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    return [{ file: MANIFEST_FILE, message: `${gatePath}: equivalentMutants must be an array` }];
  }
  return value.flatMap((entry: unknown, index: number) =>
    allowanceProblems(entry).map((problem) => ({
      file: MANIFEST_FILE,
      message: `${gatePath}: equivalentMutants[${index}]${problem}`,
    }))
  );
}

/** True when every field of the allowance is usable for matching. */
export function isUsableEquivalentMutant(entry: unknown): entry is EquivalentMutant {
  return allowanceProblems(entry).length === 0;
}

function parseEntries<T extends { path: string }>(
  kind: 'gates' | 'candidates',
  entries: unknown[],
  fields: string[],
  violations: Violation[]
): T[] {
  const usable: T[] = [];
  const seen = new Set<string>();
  entries.forEach((entry, index) => {
    const at = `${kind}[${index}]`;
    if (!isRecord(entry)) {
      violations.push({ file: MANIFEST_FILE, message: `${at} must be an object` });
      return;
    }
    if (!isFilled(entry.path)) {
      violations.push({ file: MANIFEST_FILE, message: `${at}: "path" is missing` });
      return;
    }
    for (const field of fields) {
      if (!isFilled(entry[field])) {
        violations.push({
          file: MANIFEST_FILE,
          message: `${entry.path}: "${field}" is missing in ${kind}`,
        });
      }
    }
    if (seen.has(entry.path)) {
      violations.push({ file: MANIFEST_FILE, message: `${entry.path}: listed twice in ${kind}` });
      return;
    }
    seen.add(entry.path);
    usable.push(entry as unknown as T);
  });
  return usable;
}

/**
 * Parses test-gates.json. Throws ManifestError when the file is not usable at all;
 * returns per-entry problems as violations.
 */
export function parseManifest(text: string): ParsedManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new ManifestError(`${MANIFEST_FILE} is not valid JSON: ${(error as Error).message}`);
  }
  if (!isRecord(raw)) {
    throw new ManifestError(`${MANIFEST_FILE} must be a JSON object`);
  }
  if (!Array.isArray(raw.gates)) {
    throw new ManifestError(`${MANIFEST_FILE}: "gates" must be an array`);
  }
  // `candidates` may be omitted (e.g. a coverage-only manifest); when present it must be an array.
  if (raw.candidates !== undefined && !Array.isArray(raw.candidates)) {
    throw new ManifestError(`${MANIFEST_FILE}: "candidates" must be an array`);
  }
  for (const key of Object.keys(raw)) {
    if (!['$schema', 'gates', 'candidates', 'settings'].includes(key)) {
      throw new ManifestError(`${MANIFEST_FILE}: unknown top-level key ${JSON.stringify(key)}`);
    }
  }

  const violations: Violation[] = [];
  if (raw.gates.length === 0) {
    violations.push({
      file: MANIFEST_FILE,
      message: 'gates is empty. A project with nothing to gate should not have this file',
    });
  }
  const gates = parseEntries<Gate>('gates', raw.gates, ['decides', 'impact'], violations);
  const candidates = parseEntries<Candidate>(
    'candidates',
    (raw.candidates as unknown[] | undefined) ?? [],
    ['decides', 'blocker'],
    violations
  );

  const gatePaths = new Set(gates.map((gate) => gate.path));
  for (const candidate of candidates) {
    if (gatePaths.has(candidate.path)) {
      violations.push({
        file: MANIFEST_FILE,
        message: `${candidate.path}: listed in both gates and candidates`,
      });
    }
  }
  for (const gate of gates) {
    violations.push(...validateEquivalentMutants(gate.path, gate.equivalentMutants));
  }

  return { gates, candidates, settings: raw.settings, violations };
}
