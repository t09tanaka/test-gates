import { parseImports, type ImportRef } from './imports.js';
import type { CompiledRule, ImportAlias } from './types.js';

/** One entry of `settings.imports.allow`, compiled. */
export interface ImportAllowRule {
  /** Package name: matches the specifier itself and its subpaths (`date-fns`, `date-fns/locale`). */
  module?: string;
  /** Pattern tested against the whole specifier. */
  regex?: RegExp;
  /** When given, only these names may be imported, and only as named imports. */
  names?: string[];
}

const SCRIPT_EXTENSION = /\.[cm]?[jt]sx?$/;

/** True for an import that stays inside the project: relative, or through an import alias. */
export function isProjectImport(specifier: string, aliases: ImportAlias[]): boolean {
  return specifier.startsWith('.') || aliases.some((alias) => specifier.startsWith(alias.prefix));
}

/**
 * The project path a specifier points at, without its script extension, or null for a
 * package. `./money.js` imported from `src/a.ts` is `src/money`.
 */
export function resolveSpecifier(
  specifier: string,
  fromFile: string,
  aliases: ImportAlias[]
): string | null {
  let joined: string | null = null;
  if (specifier.startsWith('.')) {
    const slash = fromFile.lastIndexOf('/');
    joined = slash === -1 ? specifier : `${fromFile.slice(0, slash)}/${specifier}`;
  } else {
    const alias = aliases.find((candidate) => specifier.startsWith(candidate.prefix));
    if (alias) {
      joined = alias.target + specifier.slice(alias.prefix.length);
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

function matches(rule: ImportAllowRule, specifier: string): boolean {
  if (rule.regex) {
    return rule.regex.test(specifier);
  }
  return specifier === rule.module || specifier.startsWith(`${rule.module}/`);
}

/**
 * Allowlist mode: a runtime import of a package (or a Node.js built-in) must be listed in
 * `settings.imports.allow`. Project imports are judged elsewhere; type-only imports never
 * reach this function.
 *
 * @returns Why the import is not allowed, or null when it is.
 */
export function judgePackageImport(ref: ImportRef, allow: ImportAllowRule[]): string | null {
  const rules = allow.filter((rule) => matches(rule, ref.module));
  if (rules.length === 0) {
    return `runtime import of "${ref.module}" is not in settings.imports.allow (allowlist mode allows relative imports, import aliases and listed packages only)`;
  }
  if (rules.some((rule) => rule.names === undefined)) {
    return null;
  }
  const allowedNames = rules.flatMap((rule) => rule.names as string[]);
  if (ref.whole) {
    return `only ${allowedNames.join(', ')} may be imported from "${ref.module}", as named imports (settings.imports.allow)`;
  }
  const extra = ref.names.filter((name) => !allowedNames.includes(name));
  return extra.length === 0
    ? null
    : `runtime import of ${extra.join(', ')} from "${ref.module}" is not in settings.imports.allow (allowed: ${allowedNames.join(', ')})`;
}

/**
 * Allowlist mode: a project import must not point at a file that could not be a gate itself
 * (`settings.impurePaths`: a service, a component, ...). The import has no extension, so each
 * gate extension is tried.
 *
 * @param target Result of resolveSpecifier.
 * @returns Why the target is not allowed, or null when it is.
 */
export function judgeProjectImport(
  target: string,
  impurePaths: CompiledRule[],
  gateExtensions: string[]
): string | null {
  const candidates = [target, ...gateExtensions.map((extension) => target + extension)];
  for (const rule of impurePaths) {
    if (candidates.some((candidate) => rule.regex.test(candidate))) {
      return rule.reason;
    }
  }
  return null;
}

/**
 * The files among `others` that import `gatePath` at runtime. When a gate is imported by
 * another gate, the importer's spec executes it too, so leaving out the gate's own spec does
 * not lower its coverage: `test-gates selfcheck` uses this to say where to look.
 */
export function findImporters(
  gatePath: string,
  others: { path: string; source: string }[],
  aliases: ImportAlias[]
): string[] {
  const target = gatePath.replace(SCRIPT_EXTENSION, '');
  const asDirectory = target.replace(/\/index$/, '');
  return others
    .filter(
      (other) =>
        other.path !== gatePath &&
        parseImports(other.source).some((imported) => {
          if (imported.typeOnly) {
            return false;
          }
          const resolved = resolveSpecifier(imported.module, other.path, aliases);
          return resolved === target || resolved === asDirectory;
        })
    )
    .map((other) => other.path);
}
