import { describe, expect, it } from 'vitest';
import { vitestCoverageViolation } from './vitest-coverage';

const V8_CONFIG = 'export default defineConfig(createVitestGatesConfig({ rootDir: __dirname }));';

describe('vitestCoverageViolation', () => {
  it.each(['3.2.7', '3.0.0', '2.1.9', '1.6.0'])(
    'warns for Vitest %s with the v8 provider',
    (version) => {
      expect(vitestCoverageViolation({ vitestVersion: version, configSource: V8_CONFIG })).toBe(
        `Vitest ${version} with the v8 coverage provider does not count the skipped side of an "if" without "else", so a gate can show 100% branches with that side untested. Use coverageProvider: 'istanbul' (needs @vitest/coverage-istanbul), set coverage.experimentalAstAwareRemapping: true, or move to Vitest 4`
      );
    }
  );

  it.each(['4.0.0', '4.1.11', '5.0.0', '10.0.0'])('does not warn for Vitest %s', (version) => {
    expect(vitestCoverageViolation({ vitestVersion: version, configSource: V8_CONFIG })).toBeNull();
  });

  it.each([
    "createVitestGatesConfig({ rootDir: __dirname, coverageProvider: 'istanbul' })",
    'test: { coverage: { provider: "istanbul" } }',
    'coverage: { experimentalAstAwareRemapping: true }',
    'coverage: { experimentalAstAwareRemapping : true, }',
    'coverage:{experimentalAstAwareRemapping:true}',
  ])('does not warn for Vitest 3 when the config has %s', (configSource) => {
    expect(vitestCoverageViolation({ vitestVersion: '3.2.7', configSource })).toBeNull();
  });

  it.each([
    'coverage: { experimentalAstAwareRemapping: false }',
    'coverage: { experimentalAstAwareRemapping: trueish }',
    "coverage: { provider: 'v8' } // not istanbulish",
  ])('still warns when the config has %s', (configSource) => {
    expect(vitestCoverageViolation({ vitestVersion: '3.2.7', configSource })).not.toBeNull();
  });

  it('does not warn when the version is unknown or not a version', () => {
    expect(vitestCoverageViolation({ vitestVersion: null, configSource: V8_CONFIG })).toBeNull();
    expect(
      vitestCoverageViolation({ vitestVersion: 'latest', configSource: V8_CONFIG })
    ).toBeNull();
    expect(
      vitestCoverageViolation({ vitestVersion: '3.5x.1', configSource: V8_CONFIG })
    ).not.toBeNull();
    expect(vitestCoverageViolation({ vitestVersion: '', configSource: V8_CONFIG })).toBeNull();
  });
});
