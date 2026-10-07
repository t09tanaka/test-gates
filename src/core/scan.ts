import { parseImports } from './imports.js';
import type { ImportAlias, ResolvedSettings, Violation } from './types.js';

const IGNORE_DIRECTIVE = /\b(istanbul|c8|v8)\s+ignore\b/;
// A decorator at the start of a line: `@Injectable()`, `@Column({ … })`. A JSDoc tag such as
// ` * @param (x)` does not match because the line starts with `*`.
const DECORATOR = /^\s*@[A-Za-z_$][\w$.]*\s*\(/;
const STRYKER_COMMENT = /Stryker\s+(disable|restore)\b/;
const DISABLED_TESTS: { regex: RegExp; label: string }[] = [
  { regex: /\.\s*(skip|only|todo)\b/, label: '.skip / .only / .todo' },
  {
    regex: /\b(?:describe|it|test|suite)(?:\s*\.\s*\w+)*\s*\.\s*(?:skipIf|runIf|fails)\b/,
    label: '.skipIf / .runIf / .fails',
  },
  {
    regex: /\b(xit|xtest|xdescribe|fit|fdescribe)\s*[.(]/,
    label: 'xit / xtest / xdescribe / fit / fdescribe',
  },
];
const MODULE_MOCK =
  /\b(?:jest|vi)\s*\.\s*(?:mock|doMock|unstable_mockModule|setMock)\s*\(\s*(?:import\s*\(\s*)?(['"`])([^'"`\n]+)\1/g;
const SCRIPT_EXTENSION = /\.[cm]?[jt]sx?$/;

type GateScanSettings = Pick<
  ResolvedSettings,
  'impureImports' | 'allowedImports' | 'impureNamedImports' | 'forbiddenSource'
>;

function eachLine(source: string, visit: (line: string, lineNumber: number) => void): void {
  source.split('\n').forEach((line, index) => visit(line, index + 1));
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Checks the text of a gate: it must be a pure module with no way to opt out of measurement. */
export function scanGateSource(
  gatePath: string,
  source: string,
  settings: GateScanSettings
): Violation[] {
  const violations: Violation[] = [];

  eachLine(source, (line, lineNumber) => {
    if (DECORATOR.test(line)) {
      violations.push({
        file: gatePath,
        line: lineNumber,
        message: 'decorator found (not a pure module). Move the file to candidates',
      });
    }
    if (IGNORE_DIRECTIVE.test(line)) {
      violations.push({ file: gatePath, line: lineNumber, message: 'coverage ignore directive' });
    }
    if (STRYKER_COMMENT.test(line)) {
      violations.push({
        file: gatePath,
        line: lineNumber,
        message:
          'Stryker disable / restore comment. Allow an equivalent mutant in test-gates.json (equivalentMutants) instead',
      });
    }
    for (const rule of settings.forbiddenSource) {
      if (rule.regex.test(line)) {
        violations.push({ file: gatePath, line: lineNumber, message: rule.reason });
      }
    }
  });

  for (const imported of parseImports(source)) {
    if (imported.typeOnly) {
      continue;
    }
    if (!settings.allowedImports.some((regex) => regex.test(imported.module))) {
      for (const rule of settings.impureImports) {
        if (rule.regex.test(imported.module)) {
          violations.push({
            file: gatePath,
            line: imported.line,
            message: `runtime import of "${imported.module}" (${rule.reason})`,
          });
        }
      }
    }
    for (const rule of settings.impureNamedImports) {
      if (imported.module !== rule.module) {
        continue;
      }
      const hit = rule.names.filter(
        (name) =>
          imported.names.includes(name) ||
          (imported.whole && new RegExp(`\\b${escapeRegExp(name)}\\b`).test(source))
      );
      if (hit.length > 0) {
        violations.push({
          file: gatePath,
          line: imported.line,
          message: `runtime use of ${hit.join(', ')} from "${rule.module}" (${rule.reason})`,
        });
      }
    }
  }

  return violations.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
}

function resolveSpecifier(
  specifier: string,
  fromFile: string,
  aliases: ImportAlias[]
): string | null {
  let joined: string | null = null;
  if (specifier.startsWith('.')) {
    const directory = fromFile.includes('/') ? fromFile.slice(0, fromFile.lastIndexOf('/')) : '';
    joined = directory === '' ? specifier : `${directory}/${specifier}`;
  } else {
    for (const alias of aliases) {
      if (specifier.startsWith(alias.prefix)) {
        joined = alias.target + specifier.slice(alias.prefix.length);
        break;
      }
    }
  }
  if (joined === null) {
    return null;
  }
  const segments: string[] = [];
  for (const segment of joined.split('/')) {
    if (segment === '..') {
      segments.pop();
    } else if (segment !== '.' && segment !== '') {
      segments.push(segment);
    }
  }
  return segments.join('/').replace(SCRIPT_EXTENSION, '');
}

/** Checks the text of a gate's spec: nothing skipped, nothing focused, the gate itself not mocked. */
export function scanSpecSource(
  gatePath: string,
  specPath: string,
  source: string,
  settings: Pick<ResolvedSettings, 'importAliases'>
): Violation[] {
  const violations: Violation[] = [];

  eachLine(source, (line, lineNumber) => {
    if (IGNORE_DIRECTIVE.test(line)) {
      violations.push({ file: specPath, line: lineNumber, message: 'coverage ignore directive' });
    }
    for (const { regex, label } of DISABLED_TESTS) {
      if (regex.test(line)) {
        violations.push({
          file: specPath,
          line: lineNumber,
          message: `${label} (a skipped or focused test)`,
        });
      }
    }
  });

  const gateModule = gatePath.replace(SCRIPT_EXTENSION, '');
  const gateDirectory = gateModule.replace(/\/index$/, '');
  for (const match of source.matchAll(MODULE_MOCK)) {
    const specifier = match[2] as string;
    const resolved = resolveSpecifier(specifier, specPath, settings.importAliases);
    if (resolved === gateModule || resolved === gateDirectory) {
      let line = 1;
      for (let i = 0; i < match.index; i += 1) {
        if (source[i] === '\n') {
          line += 1;
        }
      }
      violations.push({
        file: specPath,
        line,
        message: `mocks the module under test ("${specifier}")`,
      });
    }
  }

  return violations.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
}

/** Settings that would let a Stryker config skip mutants without an allowance. */
const STRYKER_WEAKENING = /\b(excludedMutations|ignoreStatic|ignorers)\b/;

export function scanStrykerConfig(configPath: string, source: string): Violation[] {
  const violations: Violation[] = [];
  eachLine(source, (line, lineNumber) => {
    const match = STRYKER_WEAKENING.exec(line);
    if (match) {
      violations.push({
        file: configPath,
        line: lineNumber,
        message: `${match[1]} takes mutants out of the evaluation. Allow equivalent mutants one by one in test-gates.json instead`,
      });
    }
  });
  return violations;
}
