import { describe, expect, it } from 'vitest';
import { gateExtensionOf, looksLikeSpec, specCandidatesFor } from './spec-path';

const defaults = {
  gateExtensions: ['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs'],
  specSuffixes: null,
  specRewrite: [],
};

describe('gateExtensionOf', () => {
  it('returns the extension the path ends with', () => {
    expect(gateExtensionOf('src/a.ts', ['.ts', '.js'])).toBe('.ts');
    expect(gateExtensionOf('src/a.js', ['.ts', '.js'])).toBe('.js');
  });

  it('prefers the longest matching extension, whatever the order', () => {
    expect(gateExtensionOf('lib/a.g.dart', ['.dart', '.g.dart'])).toBe('.g.dart');
    expect(gateExtensionOf('lib/a.g.dart', ['.g.dart', '.dart'])).toBe('.g.dart');
  });

  it('returns null when no extension matches', () => {
    expect(gateExtensionOf('src/a.vue', ['.ts', '.js'])).toBeNull();
    expect(gateExtensionOf('src/a.ts', [])).toBeNull();
  });
});

describe('specCandidatesFor', () => {
  it('looks for .spec and .test next to the gate, keeping its extension', () => {
    expect(specCandidatesFor('src/common/money.ts', defaults)).toEqual([
      'src/common/money.spec.ts',
      'src/common/money.test.ts',
    ]);
    expect(specCandidatesFor('lib/rate.mjs', defaults)).toEqual([
      'lib/rate.spec.mjs',
      'lib/rate.test.mjs',
    ]);
  });

  it('uses settings.spec.suffixes literally when given', () => {
    expect(specCandidatesFor('src/money.ts', { ...defaults, specSuffixes: ['.test.ts'] })).toEqual([
      'src/money.test.ts',
    ]);
  });

  it('returns nothing when the project has no spec convention', () => {
    expect(specCandidatesFor('src/money.ts', { ...defaults, specSuffixes: [] })).toEqual([]);
  });

  it('applies settings.spec.rewrite to the directory before adding the suffix', () => {
    expect(
      specCandidatesFor('app/utils/planExpiry.ts', {
        ...defaults,
        specSuffixes: ['.spec.ts'],
        specRewrite: [{ regex: /^app\//, to: 'tests/' }],
      })
    ).toEqual(['tests/utils/planExpiry.spec.ts']);
  });

  it('applies every rewrite in order', () => {
    expect(
      specCandidatesFor('lib/models/coupon.dart', {
        gateExtensions: ['.dart'],
        specSuffixes: ['_test.dart'],
        specRewrite: [
          { regex: /^lib\//, to: 'test/' },
          { regex: /^test\/models\//, to: 'test/unit/models/' },
        ],
      })
    ).toEqual(['test/unit/models/coupon_test.dart']);
  });

  it('returns nothing for a path that is not a gate extension', () => {
    expect(specCandidatesFor('src/Button.vue', defaults)).toEqual([]);
  });
});

describe('looksLikeSpec', () => {
  it.each(['src/money.spec.ts', 'src/money.test.ts', 'src/money.test.mjs'])(
    'is true for %s',
    (file) => {
      expect(looksLikeSpec(file, defaults)).toBe(true);
    }
  );

  it('is false for an implementation file', () => {
    expect(looksLikeSpec('src/money.ts', defaults)).toBe(false);
    expect(looksLikeSpec('src/spec.ts', defaults)).toBe(false);
  });

  it('follows settings.spec.suffixes', () => {
    const settings = { ...defaults, specSuffixes: ['.test.ts'] };
    expect(looksLikeSpec('src/money.test.ts', settings)).toBe(true);
    expect(looksLikeSpec('src/money.spec.ts', settings)).toBe(false);
  });

  it('is false for a path that is not a gate extension', () => {
    expect(looksLikeSpec('src/money.spec.tsx', defaults)).toBe(false);
  });
});
