/**
 * Measured with Vitest 3.2.7 and 4.1.11 (see README, "Vitest: v8 or istanbul"): the v8
 * provider of Vitest 3 reports 100% branches for an `if` without `else` whose skipped side is
 * never tested, unless `experimentalAstAwareRemapping` is on. Vitest 4 and istanbul report it.
 *
 * @param input.vitestVersion Installed Vitest version, or null when it cannot be found.
 * @param input.configSource Text of the gate config.
 * @returns A warning for `test-gates check`, or null when the setup detects the gap.
 */
export function vitestCoverageWarning(input: {
  vitestVersion: string | null;
  configSource: string;
}): string | null {
  if (input.vitestVersion === null || input.vitestVersion === '') {
    return null;
  }
  const major = Number(input.vitestVersion.split('.')[0]);
  if (!Number.isInteger(major) || major >= 4) {
    return null;
  }
  if (
    /\bistanbul\b/.test(input.configSource) ||
    /\bexperimentalAstAwareRemapping\s*:\s*true\b/.test(input.configSource)
  ) {
    return null;
  }
  return `Vitest ${input.vitestVersion} with the v8 coverage provider does not count the skipped side of an "if" without "else", so a gate can show 100% branches with that side untested. Use coverageProvider: 'istanbul' (needs @vitest/coverage-istanbul), set coverage.experimentalAstAwareRemapping: true, or move to Vitest 4`;
}
