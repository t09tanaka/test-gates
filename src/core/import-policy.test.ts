import { describe, expect, it } from 'vitest';
import {
  findImporters,
  isProjectImport,
  judgePackageImport,
  judgeProjectImport,
  resolveSpecifier,
} from './import-policy';
import type { ImportRef } from './imports';

const aliases = [
  { prefix: '@/', target: 'src/' },
  { prefix: '~', target: 'never/' },
];

const ref = (module: string, overrides: Partial<ImportRef> = {}): ImportRef => ({
  module,
  line: 1,
  typeOnly: false,
  names: [],
  whole: false,
  ...overrides,
});

describe('isProjectImport', () => {
  it.each(['./money', '../common/money', '.', '..'])('is true for the relative %s', (specifier) => {
    expect(isProjectImport(specifier, [])).toBe(true);
  });

  it('is true for a specifier that starts with an alias prefix', () => {
    expect(isProjectImport('@/common/money', aliases)).toBe(true);
    expect(isProjectImport('~x', aliases)).toBe(true);
  });

  it.each(['decimal.js', '@prisma/client', 'node:fs', 'src/money', '@scope/pkg'])(
    'is false for the package %s',
    (specifier) => {
      expect(isProjectImport(specifier, aliases)).toBe(false);
    }
  );

  it('is false for an aliased specifier when no alias is configured', () => {
    expect(isProjectImport('@/common/money', [])).toBe(false);
  });
});

describe('resolveSpecifier', () => {
  it.each([
    ['./money', 'src/common/a.ts', 'src/common/money'],
    ['./money.js', 'src/common/a.ts', 'src/common/money'],
    ['./money.ts', 'src/common/a.ts', 'src/common/money'],
    ['./money.mts', 'src/common/a.ts', 'src/common/money'],
    ['./view.tsx', 'src/common/a.ts', 'src/common/view'],
    ['../money', 'src/common/a.ts', 'src/money'],
    ['../../lib/x', 'src/common/a.ts', 'lib/x'],
    ['./../common/./money', 'src/common/a.ts', 'src/common/money'],
    ['.', 'src/auth/index.spec.ts', 'src/auth'],
    ['./', 'src/auth/index.spec.ts', 'src/auth'],
    ['..', 'src/auth/index.spec.ts', 'src'],
    ['./money', 'a.ts', 'money'],
    ['./Card.vue', 'src/a.ts', 'src/Card.vue'],
    ['./data.json', 'src/a.ts', 'src/data.json'],
  ])('resolves %s from %s to %s', (specifier, fromFile, expected) => {
    expect(resolveSpecifier(specifier, fromFile, [])).toBe(expected);
  });

  it('resolves through the first alias whose prefix matches', () => {
    expect(resolveSpecifier('@/common/money', 'tests/a.spec.ts', aliases)).toBe('src/common/money');
    expect(resolveSpecifier('@/common/money.ts', 'tests/a.spec.ts', aliases)).toBe(
      'src/common/money'
    );
    expect(
      resolveSpecifier('~/x', 'a.ts', [
        { prefix: '~/', target: '' },
        { prefix: '~', target: 'never/' },
      ])
    ).toBe('x');
  });

  it('returns null for a package, with or without aliases', () => {
    expect(resolveSpecifier('decimal.js', 'src/a.ts', aliases)).toBeNull();
    expect(resolveSpecifier('@/common/money', 'src/a.ts', [])).toBeNull();
  });
});

describe('judgePackageImport', () => {
  const notListed = (module: string) =>
    `runtime import of "${module}" is not in settings.imports.allow (allowlist mode allows relative imports, import aliases and listed packages only)`;

  it('rejects a package when nothing is listed', () => {
    expect(judgePackageImport(ref('lodash', { whole: true }), [])).toBe(notListed('lodash'));
  });

  it('rejects a Node.js built-in unless it is listed, with or without node:', () => {
    expect(judgePackageImport(ref('fs'), [{ module: 'decimal.js' }])).toBe(notListed('fs'));
    expect(judgePackageImport(ref('node:path'), [{ module: 'path' }])).toBe(notListed('node:path'));
    expect(judgePackageImport(ref('node:path'), [{ module: 'node:path' }])).toBeNull();
  });

  it('allows a listed package and its subpaths, but not a longer name', () => {
    const allow = [{ module: 'date-fns' }];
    expect(judgePackageImport(ref('date-fns', { names: ['addDays'] }), allow)).toBeNull();
    expect(judgePackageImport(ref('date-fns/locale', { whole: true }), allow)).toBeNull();
    expect(judgePackageImport(ref('date-fns-tz'), allow)).toBe(notListed('date-fns-tz'));
    expect(judgePackageImport(ref('date'), allow)).toBe(notListed('date'));
  });

  it('allows a specifier matched by a pattern', () => {
    const allow = [{ regex: /^@acme\/pure-/ }];
    expect(judgePackageImport(ref('@acme/pure-money', { whole: true }), allow)).toBeNull();
    expect(judgePackageImport(ref('@acme/db'), allow)).toBe(notListed('@acme/db'));
  });

  describe('with a name-level entry', () => {
    const allow = [{ module: '@prisma/client', names: ['Prisma', 'OrderStatus'] }];

    it('allows the listed names as named imports', () => {
      expect(judgePackageImport(ref('@prisma/client', { names: ['Prisma'] }), allow)).toBeNull();
      expect(
        judgePackageImport(ref('@prisma/client', { names: ['OrderStatus', 'Prisma'] }), allow)
      ).toBeNull();
    });

    it('allows an import that brings in no name', () => {
      expect(judgePackageImport(ref('@prisma/client'), allow)).toBeNull();
    });

    it('rejects any other name and says which', () => {
      expect(
        judgePackageImport(ref('@prisma/client', { names: ['Prisma', 'PrismaClient', 'x'] }), allow)
      ).toBe(
        'runtime import of PrismaClient, x from "@prisma/client" is not in settings.imports.allow (allowed: Prisma, OrderStatus)'
      );
    });

    it('rejects a default, namespace or require import, even with an allowed name', () => {
      expect(
        judgePackageImport(ref('@prisma/client', { whole: true, names: ['Prisma'] }), allow)
      ).toBe(
        'only Prisma, OrderStatus may be imported from "@prisma/client", as named imports (settings.imports.allow)'
      );
    });

    it('does not apply to another module', () => {
      expect(
        judgePackageImport(ref('@prisma/client/runtime', { names: ['Prisma'] }), allow)
      ).toBeNull();
      expect(judgePackageImport(ref('prisma', { names: ['Prisma'] }), allow)).toBe(
        notListed('prisma')
      );
    });

    it('unites the names of several entries for the same module', () => {
      const both = [...allow, { module: '@prisma/client', names: ['Role'] }];
      expect(
        judgePackageImport(ref('@prisma/client', { names: ['Role', 'Prisma'] }), both)
      ).toBeNull();
      expect(judgePackageImport(ref('@prisma/client', { names: ['Other'] }), both)).toBe(
        'runtime import of Other from "@prisma/client" is not in settings.imports.allow (allowed: Prisma, OrderStatus, Role)'
      );
    });

    it('is overridden by an entry that allows the whole module', () => {
      const whole = [...allow, { module: '@prisma/client' }];
      expect(
        judgePackageImport(ref('@prisma/client', { whole: true, names: ['PrismaClient'] }), whole)
      ).toBeNull();
      const byPattern = [...allow, { regex: /^@prisma\// }];
      expect(
        judgePackageImport(ref('@prisma/client', { names: ['Anything'] }), byPattern)
      ).toBeNull();
    });
  });
});

describe('judgeProjectImport', () => {
  const impurePaths = [
    { regex: /\.(vue|jsx|tsx)$/, reason: 'component file' },
    { regex: /\.service\.ts$/, reason: 'NestJS class file' },
    { regex: /^src\/hooks\//, reason: 'hook' },
  ];
  const extensions = ['.ts', '.js'];

  it('allows a target that no rule matches', () => {
    expect(judgeProjectImport('src/common/money', impurePaths, extensions)).toBeNull();
    expect(judgeProjectImport('src/common/money', [], extensions)).toBeNull();
  });

  it('rejects a target whose file would match a rule once an extension is added', () => {
    expect(judgeProjectImport('src/user/user.service', impurePaths, extensions)).toBe(
      'NestJS class file'
    );
  });

  it('tries every gate extension', () => {
    const rules = [{ regex: /\.guard\.js$/, reason: 'guard' }];
    expect(judgeProjectImport('src/a.guard', rules, extensions)).toBe('guard');
    expect(judgeProjectImport('src/a.guard', rules, ['.ts'])).toBeNull();
  });

  it('rejects a target that matches as written', () => {
    expect(judgeProjectImport('src/Card.vue', impurePaths, extensions)).toBe('component file');
    expect(judgeProjectImport('src/hooks/use-cart', impurePaths, extensions)).toBe('hook');
    expect(judgeProjectImport('src/hooks/use-cart', impurePaths, [])).toBe('hook');
  });

  it('reports the first rule that matches', () => {
    expect(judgeProjectImport('src/hooks/cart.service', impurePaths, extensions)).toBe(
      'NestJS class file'
    );
  });
});

describe('findImporters', () => {
  const others = [
    { path: 'src/auth/api-key-auth.ts', source: "import { safeCompare } from './safe-compare';" },
    { path: 'src/auth/session.ts', source: "import type { Compare } from './safe-compare';" },
    {
      path: 'src/orders/total.ts',
      source: "import { safeCompare } from '@/auth/safe-compare.js';",
    },
    { path: 'src/orders/tax.ts', source: "import { round } from './round';" },
    { path: 'src/auth/safe-compare.ts', source: "import { self } from './safe-compare';" },
  ];

  it('names the files that import the gate at runtime, relative or through an alias', () => {
    expect(findImporters('src/auth/safe-compare.ts', others, aliases)).toEqual([
      'src/auth/api-key-auth.ts',
      'src/orders/total.ts',
    ]);
  });

  it('needs the alias to follow an aliased import', () => {
    expect(findImporters('src/auth/safe-compare.ts', others, [])).toEqual([
      'src/auth/api-key-auth.ts',
    ]);
  });

  it('finds nothing for a gate nobody imports', () => {
    expect(findImporters('src/orders/total.ts', others, aliases)).toEqual([]);
    expect(findImporters('src/auth/safe-compare.ts', [], aliases)).toEqual([]);
  });

  it('recognises an import of the directory of an index gate', () => {
    const importer = [
      { path: 'src/a.ts', source: "import { x } from './auth';" },
      { path: 'src/b.ts', source: "import { x } from './auth/index';" },
      { path: 'src/c.ts', source: "import { x } from './auth/other';" },
    ];
    expect(findImporters('src/auth/index.ts', importer, [])).toEqual(['src/a.ts', 'src/b.ts']);
    expect(findImporters('src/auth/reindex.ts', importer, [])).toEqual([]);
    // "/index" in the middle of the path is not an index file.
    expect(
      findImporters(
        'src/index/util.ts',
        [{ path: 'src/a.ts', source: "import { x } from './util';" }],
        []
      )
    ).toEqual([]);
  });

  it('finds the import among the other imports of a file', () => {
    const source =
      "import Decimal from 'decimal.js';\nimport { a } from './money';\nimport { b } from './tax';";
    expect(findImporters('src/money.ts', [{ path: 'src/total.ts', source }], [])).toEqual([
      'src/total.ts',
    ]);
  });
});
