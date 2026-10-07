import type { ResolvedSettings } from './types.js';

type SpecSettings = Pick<ResolvedSettings, 'gateExtensions' | 'specSuffixes' | 'specRewrite'>;

/** The configured gate extension `gatePath` ends with (longest wins), or null. */
export function gateExtensionOf(gatePath: string, gateExtensions: string[]): string | null {
  let found: string | null = null;
  for (const extension of gateExtensions) {
    if (gatePath.endsWith(extension) && (found === null || extension.length > found.length)) {
      found = extension;
    }
  }
  return found;
}

/**
 * Where the spec of a gate may live, in order of preference.
 *
 * `src/money.ts` → `src/money.spec.ts`, `src/money.test.ts` by default. `settings.spec.suffixes`
 * replaces the suffix list (an empty list means "this project has no spec convention"), and
 * `settings.spec.rewrite` moves the directory first (`^app/` → `tests/`).
 */
export function specCandidatesFor(gatePath: string, settings: SpecSettings): string[] {
  const extension = gateExtensionOf(gatePath, settings.gateExtensions);
  if (extension === null) {
    return [];
  }
  let base = gatePath.slice(0, -extension.length);
  for (const { regex, to } of settings.specRewrite) {
    base = base.replace(regex, to);
  }
  const suffixes = settings.specSuffixes ?? [`.spec${extension}`, `.test${extension}`];
  return suffixes.map((suffix) => base + suffix);
}

/** True when `gatePath` is itself named like a spec. */
export function looksLikeSpec(gatePath: string, settings: SpecSettings): boolean {
  const extension = gateExtensionOf(gatePath, settings.gateExtensions);
  if (extension === null) {
    return false;
  }
  const suffixes = settings.specSuffixes ?? [`.spec${extension}`, `.test${extension}`];
  return suffixes.some((suffix) => gatePath.endsWith(suffix));
}
