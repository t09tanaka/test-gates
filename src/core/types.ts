/** One allowed equivalent mutant. Matched by mutator + original + replacement, never by line number. */
export interface EquivalentMutant {
  mutator: string;
  original: string;
  replacement: string;
  reason: string;
  /** 1-based index among the mutants of the file that share mutator + original + replacement. */
  occurrence?: number;
}

export interface Gate {
  path: string;
  decides: string;
  impact: string;
  equivalentMutants?: EquivalentMutant[];
}

export interface Candidate {
  path: string;
  decides: string;
  blocker: string;
}

/** A regular expression written in JSON. A bare string is shorthand for `{ pattern }`. */
export interface PatternRule {
  pattern: string;
  flags?: string;
  reason?: string;
}

export interface NamedImportRule {
  module: string;
  names: string[];
  reason?: string;
}

export interface ImportAlias {
  prefix: string;
  target: string;
}

export interface SpecRewrite {
  from: string;
  to: string;
}

/** `settings` of test-gates.json. Everything is optional. */
export interface Settings {
  gateExtensions?: string[];
  spec?: {
    suffixes?: string[];
    rewrite?: SpecRewrite[];
  };
  impureImports?: {
    defaults?: boolean;
    add?: (string | PatternRule)[];
    allow?: string[];
  };
  impureNamedImports?: {
    defaults?: boolean;
    add?: NamedImportRule[];
  };
  impurePaths?: {
    defaults?: boolean;
    add?: (string | PatternRule)[];
  };
  forbiddenSource?: {
    defaults?: boolean;
    add?: (string | PatternRule)[];
  };
  importAliases?: ImportAlias[];
  gateCommand?: string[];
  selfcheck?: {
    mode?: 'all' | 'first';
    failurePattern?: string;
  };
  stryker?: {
    configFile?: string;
    reportFile?: string;
  };
  lcov?: {
    file?: string;
    summaryExclude?: string[];
  };
}

export interface Manifest {
  $schema?: string;
  gates: Gate[];
  candidates: Candidate[];
  settings?: Settings;
}

export interface CompiledRule {
  regex: RegExp;
  reason: string;
}

/** Settings with defaults applied and every pattern compiled. */
export interface ResolvedSettings {
  gateExtensions: string[];
  /** `null` means "derive `.spec<ext>` and `.test<ext>` from the gate's extension". */
  specSuffixes: string[] | null;
  specRewrite: { regex: RegExp; to: string }[];
  impureImports: CompiledRule[];
  allowedImports: RegExp[];
  impureNamedImports: Required<NamedImportRule>[];
  impurePaths: CompiledRule[];
  forbiddenSource: CompiledRule[];
  importAliases: ImportAlias[];
  gateCommand: string[] | null;
  selfcheckMode: 'all' | 'first';
  selfcheckFailurePattern: string | null;
  strykerConfigFile: string | null;
  strykerReportFile: string;
  lcovFile: string | null;
  lcovSummaryExclude: RegExp[];
}

/** One finding. Printed as `file:line: message`. */
export interface Violation {
  file: string;
  line?: number;
  message: string;
}
