export interface ImportRef {
  module: string;
  /** 1-based line of the module specifier. */
  line: number;
  /** `import type …` / `export type … from`: erased at compile time. */
  typeOnly: boolean;
  /** Imported names (the exported name, not the local alias). Inline `type X` is left out. */
  names: string[];
  /**
   * True when the whole module object is reachable: default import, `* as ns`, `export *`,
   * `require()` or `import()`. Named-import rules then fall back to scanning the source.
   */
  whole: boolean;
}

// `import X, { a, type B, c as d } from 'm'` / `export { a } from 'm'` / `export * as ns from 'm'`.
// The clause is limited to identifier characters, `{},*` and whitespace so that the match cannot
// run across unrelated statements.
const FROM_STATEMENT =
  /(?:^|[\n;])[ \t]*(import|export)\s+(type\s+)?([\w$\s,{}*]*?)\s*\bfrom\s*(['"])([^'"\n]+)\4/g;
const SIDE_EFFECT_IMPORT = /(?:^|[\n;])[ \t]*import\s*(['"])([^'"\n]+)\1/g;
const CALL_IMPORT = /\b(?:require|import)\s*\(\s*(['"`])([^'"`\n]+)\1\s*\)/g;

function lineAt(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i += 1) {
    if (source[i] === '\n') {
      line += 1;
    }
  }
  return line;
}

/**
 * Finds the module specifiers a source file imports. Text based on purpose: the checks must run
 * without the project's dependencies installed. An import inside a comment is reported too,
 * which errs on the strict side.
 */
export function parseImports(source: string): ImportRef[] {
  const found: ImportRef[] = [];

  for (const match of source.matchAll(FROM_STATEMENT)) {
    const clause = match[3] as string;
    const module = match[5] as string;
    const braces = /\{([^}]*)\}/.exec(clause);
    const names = braces
      ? (braces[1] as string)
          .split(',')
          .map((part) => part.trim())
          .filter((part) => part !== '' && !/^type\s/.test(part))
          .map((part) => (part.split(/\s+as\s+/)[0] as string).trim())
      : [];
    const outsideBraces = clause
      .replace(/\{[^}]*\}/, '')
      .replace(/,/g, '')
      .trim();
    found.push({
      module,
      line: lineAt(source, match.index + match[0].lastIndexOf(module)),
      typeOnly: match[2] !== undefined,
      names,
      whole: outsideBraces !== '',
    });
  }
  for (const match of source.matchAll(SIDE_EFFECT_IMPORT)) {
    const module = match[2] as string;
    found.push({
      module,
      line: lineAt(source, match.index + match[0].lastIndexOf(module)),
      typeOnly: false,
      names: [],
      whole: false,
    });
  }
  for (const match of source.matchAll(CALL_IMPORT)) {
    const module = match[2] as string;
    found.push({
      module,
      line: lineAt(source, match.index + match[0].lastIndexOf(module)),
      typeOnly: false,
      names: [],
      whole: true,
    });
  }

  return found.sort((a, b) => a.line - b.line);
}

// `require(name)` / `import(name)`: the argument does not start with a quote. `import.meta`
// and a method such as `loader.require(x)` are not matched.
const COMPUTED_CALL_IMPORT = /(?<![.\w$])(?:require|import)\s*\(\s*(?!['"`\s)])/g;

/**
 * Lines with a `require()` / `import()` whose specifier is not a string literal. Such an
 * import cannot be judged from the text; allowlist mode rejects it.
 */
export function findUncheckableImports(source: string): number[] {
  return [...source.matchAll(COMPUTED_CALL_IMPORT)].map((match) => lineAt(source, match.index));
}
