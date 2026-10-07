import { describe, expect, it } from 'vitest';
import { scanGateSource, scanSpecSource, scanStrykerConfig } from './scan';
import { resolveSettings } from './settings';

const defaults = resolveSettings(undefined);
const GATE = 'src/common/money.ts';
const SPEC = 'src/common/money.spec.ts';

const gate = (source: string, settings = defaults) => scanGateSource(GATE, source, settings);
const spec = (source: string, settings = defaults, gatePath = GATE, specPath = SPEC) =>
  scanSpecSource(gatePath, specPath, source, settings);

describe('scanGateSource: a pure module passes', () => {
  it('accepts plain code with relative, type-only and harmless imports', () => {
    expect(
      gate(
        [
          "import Decimal from 'decimal.js';",
          "import type { Request } from 'express';",
          "import { Prisma, OrderStatus } from '@prisma/client';",
          "import { round } from './round';",
          '/**',
          ' * @param (amount) the amount',
          ' */',
          'export const add = (a: number, b: number) => a + b;',
        ].join('\n')
      )
    ).toEqual([]);
  });
});

describe('scanGateSource: decorators', () => {
  it.each(['@Injectable()', '  @Column({ type: "int" })', '\t@UseGuards(AuthGuard)', '@a.b.c ('])(
    'reports %s',
    (line) => {
      expect(gate(`export class A {}\n${line}\nexport class B {}`)).toEqual([
        {
          file: GATE,
          line: 2,
          message: 'decorator found (not a pure module). Move the file to candidates',
        },
      ]);
    }
  );

  it.each([' * @param (x) value', 'const email = "a@b.c(x)";', '// see @Injectable()', '@media'])(
    'does not mistake %s for a decorator',
    (line) => {
      expect(gate(line)).toEqual([]);
    }
  );
});

describe('scanGateSource: ways to opt out of measurement', () => {
  it.each([
    '/* istanbul ignore next */',
    '// c8 ignore start',
    '/* v8 ignore next 3 */',
    '// istanbul  ignore file',
  ])('reports %s', (line) => {
    expect(gate(`const a = 1;\n${line}`)).toEqual([
      { file: GATE, line: 2, message: 'coverage ignore directive' },
    ]);
  });

  it('does not report the word ignore on its own', () => {
    expect(gate('// we ignore istanbul here\nconst v8ignore = 1;')).toEqual([]);
  });

  it.each([
    '// Stryker disable next-line ConditionalExpression: equivalent',
    '// Stryker disable all',
    '// Stryker restore all',
    '/* Stryker  disable BlockStatement */',
  ])('reports %s', (line) => {
    expect(gate(`${line}\nconst a = 1;`)).toEqual([
      {
        file: GATE,
        line: 1,
        message:
          'Stryker comment (disable / restore). Allow an equivalent mutant in test-gates.json (equivalentMutants) instead',
      },
    ]);
  });

  it('does not report the word Stryker on its own', () => {
    expect(gate('// Stryker does not mutate ROUND_UP\n// disabled elsewhere')).toEqual([]);
  });
});

describe('scanGateSource: impure imports', () => {
  it.each([
    [
      "import { Injectable } from '@nestjs/common';",
      '@nestjs/common',
      'NestJS runtime (DI, decorators)',
    ],
    ["import { Repository } from 'typeorm';", 'typeorm', 'database client'],
    ["import { Pool } from 'pg';", 'pg', 'database client'],
    ["import React from 'react';", 'react', 'React runtime'],
    ["import { createRoot } from 'react-dom/client';", 'react-dom/client', 'React runtime'],
    ["import { ref } from 'vue';", 'vue', 'Vue runtime'],
    ["import { cookies } from 'next/headers';", 'next/headers', 'Next.js runtime'],
    ["import { useNuxtApp } from '#app';", '#app', 'Nuxt runtime'],
    ["import { useState } from '#imports';", '#imports', 'Nuxt runtime'],
    ["import { defineNuxtPlugin } from 'nuxt/app';", 'nuxt/app', 'Nuxt runtime'],
    ["import express from 'express';", 'express', 'HTTP framework runtime'],
    ["import 'server-only';", 'server-only', 'Next.js execution environment'],
    ["import Card from './Card.vue';", './Card.vue', 'component'],
    ["const fs = require('node:fs');", 'node:fs', 'file system / network / process access'],
    [
      "const { readFile } = await import('fs/promises');",
      'fs/promises',
      'file system / network / process access',
    ],
    [
      "export { S3Client } from '@aws-sdk/client-s3';",
      '@aws-sdk/client-s3',
      'external service SDK',
    ],
  ])('reports %s', (line, module, reason) => {
    expect(gate(`const a = 1;\n${line}`)).toEqual([
      { file: GATE, line: 2, message: `runtime import of "${module}" (${reason})` },
    ]);
  });

  it.each([
    "import type { Repository } from 'typeorm';",
    "export type { Request } from 'express';",
    "import { nextTick } from './next';",
    "import { x } from 'reactive-lib';",
    "import { y } from 'vuex-like';",
    "import { z } from 'pgp';",
    "import path from 'node:path';",
  ])('does not report %s', (line) => {
    expect(gate(line)).toEqual([]);
  });

  it('exempts a module matched by settings.impureImports.allow', () => {
    const settings = resolveSettings({ impureImports: { allow: ['^express$'] } });
    expect(gate("import { Response } from 'express';", settings)).toEqual([]);
    expect(gate("import jwt from 'express-jwt';", settings)).toHaveLength(1);
  });

  it('applies patterns added by settings.impureImports.add, with their reason', () => {
    const settings = resolveSettings({
      impureImports: { add: [{ pattern: '(^|/)repository(/|$)', reason: 'DB layer' }, '^lodash$'] },
    });
    expect(
      gate("import { find } from '../repository/user';\nimport _ from 'lodash';", settings)
    ).toEqual([
      { file: GATE, line: 1, message: 'runtime import of "../repository/user" (DB layer)' },
      { file: GATE, line: 2, message: 'runtime import of "lodash" (matches ^lodash$)' },
    ]);
  });

  it('drops the built-in patterns with settings.impureImports.defaults: false', () => {
    const settings = resolveSettings({ impureImports: { defaults: false } });
    expect(gate("import React from 'react';", settings)).toEqual([]);
  });
});

describe('scanGateSource: named imports (@prisma/client)', () => {
  const message = 'runtime use of PrismaClient from "@prisma/client" (connects to the database)';

  it.each([
    "import { PrismaClient } from '@prisma/client';",
    "import { Prisma, PrismaClient as Db } from '@prisma/client';",
    "export { PrismaClient } from '@prisma/client';",
    "import * as prisma from '@prisma/client';\nconst db = new prisma.PrismaClient();",
    "const { PrismaClient } = require('@prisma/client');",
    "import pkg from '@prisma/client';\nconst { PrismaClient } = pkg;",
  ])('reports %s', (source) => {
    expect(gate(source)).toEqual([{ file: GATE, line: 1, message }]);
  });

  it.each([
    "import { Prisma } from '@prisma/client';\nexport const zero = new Prisma.Decimal(0);",
    "import { OrderStatus } from '@prisma/client';",
    "import type { PrismaClient } from '@prisma/client';",
    "import { type PrismaClient, Prisma } from '@prisma/client';",
    "import * as prisma from '@prisma/client';\nexport const d = prisma.Prisma.Decimal;",
    "import { PrismaClient } from './fake-prisma';",
    "import { PrismaClientKnownRequestError } from '@prisma/client';",
  ])('does not report %s', (source) => {
    expect(gate(source)).toEqual([]);
  });

  it('applies rules added by settings.impureNamedImports.add', () => {
    const settings = resolveSettings({
      impureNamedImports: { add: [{ module: 'lib', names: ['connect', 'pool'], reason: 'DB' }] },
    });
    expect(gate("import { connect, pure, pool } from 'lib';", settings)).toEqual([
      { file: GATE, line: 1, message: 'runtime use of connect, pool from "lib" (DB)' },
    ]);
  });
});

describe('scanGateSource: forbidden source', () => {
  it.each(["'use client';", '"use server"', "  'use server'"])('reports %s', (line) => {
    expect(gate(`${line}\nexport const a = 1;`)).toEqual([
      { file: GATE, line: 1, message: "'use client' / 'use server' directive (not a pure module)" },
    ]);
  });

  it('does not report the phrase in the middle of a line or with mismatched quotes', () => {
    expect(gate(`const s = 'use client';\n'use client"`)).toEqual([]);
  });

  it('applies settings.forbiddenSource.add line by line', () => {
    const settings = resolveSettings({
      forbiddenSource: { add: [{ pattern: 'process\\.env', reason: 'reads the environment' }] },
    });
    expect(gate('const a = 1;\nconst b = process.env.B;', settings)).toEqual([
      { file: GATE, line: 2, message: 'reads the environment' },
    ]);
  });
});

describe('scanGateSource: several findings', () => {
  it('reports all of them in line order', () => {
    const source = [
      "import { Injectable } from '@nestjs/common';",
      '',
      '@Injectable()',
      'export class A {',
      '  /* istanbul ignore next */',
      '  // Stryker disable next-line all',
      '}',
    ].join('\n');
    expect(gate(source).map((violation) => violation.line)).toEqual([1, 3, 5, 6]);
  });
});

describe('scanSpecSource: skipped and focused tests', () => {
  it.each([
    ['it.skip("x", () => {});', '.skip / .only / .todo'],
    ['describe.only("x", () => {});', '.skip / .only / .todo'],
    ['test.todo("x");', '.skip / .only / .todo'],
    ['it.each([1]).skip("x", () => {});', '.skip / .only / .todo'],
    ['it . only("x", () => {});', '.skip / .only / .todo'],
    ['const t = it; t.skip("x");', '.skip / .only / .todo'],
    ['it.skipIf(true)("x", () => {});', '.skipIf / .runIf / .fails'],
    ['describe.runIf(false)("x", () => {});', '.skipIf / .runIf / .fails'],
    ['test.fails("x", () => {});', '.skipIf / .runIf / .fails'],
    ['test.concurrent.fails("x", () => {});', '.skipIf / .runIf / .fails'],
    ['xit("x", () => {});', 'xit / xtest / xdescribe / fit / fdescribe'],
    ['xtest("x", () => {});', 'xit / xtest / xdescribe / fit / fdescribe'],
    ['xdescribe("x", () => {});', 'xit / xtest / xdescribe / fit / fdescribe'],
    ['fit("x", () => {});', 'xit / xtest / xdescribe / fit / fdescribe'],
    ['fdescribe("x", () => {});', 'xit / xtest / xdescribe / fit / fdescribe'],
    ['xit.each([1])("x", () => {});', 'xit / xtest / xdescribe / fit / fdescribe'],
  ])('reports %s', (line, label) => {
    expect(spec(`import { add } from './money';\n${line}`)).toEqual([
      { file: SPEC, line: 2, message: `${label} (a skipped or focused test)` },
    ]);
  });

  it.each([
    'it("skips nothing", () => {});',
    'it.each([[1, 2]])("adds %i", () => {});',
    'expect(result.fails).toBe(true);',
    'const only = 1; const skip = 2; const todo = 3;',
    'benefit("x"); outfit(1); exit(0);',
    'expect(readonly).toBe(1);',
  ])('does not report %s', (line) => {
    expect(spec(line)).toEqual([]);
  });

  it('reports a coverage ignore directive in the spec', () => {
    expect(spec('// ok\n/* v8 ignore next */')).toEqual([
      { file: SPEC, line: 2, message: 'coverage ignore directive' },
    ]);
  });
});

describe('scanSpecSource: mocking the module under test', () => {
  const selfMock = (specifier: string) => ({
    file: SPEC,
    line: 2,
    message: `mocks the module under test ("${specifier}")`,
  });

  it.each([
    ["jest.mock('./money');", './money'],
    ['vi.mock("./money.ts");', './money.ts'],
    ["vi.doMock('../common/money');", '../common/money'],
    ["jest.unstable_mockModule('./money.js', () => ({}));", './money.js'],
    ["jest.setMock('./money', {});", './money'],
    ["vi.mock(import('./money'), () => ({}));", './money'],
    ['jest . mock ( `./money` );', './money'],
    ["jest.mock('./../common/./money');", './../common/./money'],
  ])('reports %s', (line, specifier) => {
    expect(spec(`import { add } from './money';\n${line}`)).toEqual([selfMock(specifier)]);
  });

  it.each([
    "jest.mock('./money-format');",
    "jest.mock('../money');",
    "jest.mock('decimal.js');",
    "vi.mock('./currency');",
    "other.mock('./money');",
    "jest.spyOn(console, 'log');",
  ])('does not report %s', (line) => {
    expect(spec(line)).toEqual([]);
  });

  it('resolves import aliases from settings.importAliases', () => {
    const settings = resolveSettings({ importAliases: [{ prefix: '@/', target: 'src/' }] });
    expect(spec("\njest.mock('@/common/money');", settings)).toEqual([selfMock('@/common/money')]);
    expect(spec("\njest.mock('@/common/other');", settings)).toEqual([]);
    // Without the alias the specifier cannot be resolved, so it is not reported.
    expect(spec("\njest.mock('@/common/money');")).toEqual([]);
  });

  it('uses the first alias whose prefix matches', () => {
    const settings = resolveSettings({
      importAliases: [
        { prefix: '~/', target: '' },
        { prefix: '~', target: 'never/' },
      ],
    });
    expect(spec("\nvi.mock('~/src/common/money');", settings)).toEqual([
      selfMock('~/src/common/money'),
    ]);
  });

  it('recognises a mock of the directory when the gate is an index file', () => {
    expect(
      spec(
        "\njest.mock('.');\njest.mock('./index');",
        defaults,
        'src/auth/index.ts',
        'src/auth/index.spec.ts'
      )
    ).toEqual([
      { file: 'src/auth/index.spec.ts', line: 2, message: 'mocks the module under test (".")' },
      {
        file: 'src/auth/index.spec.ts',
        line: 3,
        message: 'mocks the module under test ("./index")',
      },
    ]);
  });

  it('resolves a spec that lives in another directory', () => {
    expect(
      spec(
        "\nvi.mock('../../app/utils/plan');",
        defaults,
        'app/utils/plan.ts',
        'tests/utils/plan.spec.ts'
      )
    ).toEqual([
      {
        file: 'tests/utils/plan.spec.ts',
        line: 2,
        message: 'mocks the module under test ("../../app/utils/plan")',
      },
    ]);
  });

  it('resolves a spec at the project root', () => {
    expect(spec("\njest.mock('./money');", defaults, 'money.ts', 'money.spec.ts')).toEqual([
      { file: 'money.spec.ts', line: 2, message: 'mocks the module under test ("./money")' },
    ]);
  });

  it('reports findings in line order', () => {
    const source = "jest.mock('./money');\nit.skip('x', () => {});";
    expect(spec(source).map((violation) => violation.line)).toEqual([1, 2]);
  });
});

describe('scanStrykerConfig', () => {
  it.each(['excludedMutations', 'ignoreStatic', 'ignorers'])('reports %s', (option) => {
    expect(
      scanStrykerConfig('stryker.gates.config.mjs', `export default {\n  ${option}: true,\n};`)
    ).toEqual([
      {
        file: 'stryker.gates.config.mjs',
        line: 2,
        message: `${option} takes mutants out of the evaluation. Allow equivalent mutants one by one in test-gates.json instead`,
      },
    ]);
  });

  it('accepts a config that does not weaken the run', () => {
    expect(
      scanStrykerConfig(
        'stryker.gates.config.mjs',
        "export default { testRunner: 'jest', ignorePatterns: ['dist'], thresholds: { break: null } };"
      )
    ).toEqual([]);
  });
});

describe('scanGateSource: allowlist mode', () => {
  const allowlist = (extra: object = {}) =>
    resolveSettings({
      importAliases: [{ prefix: '@/', target: 'src/' }],
      impurePaths: { add: [{ pattern: '\\.service\\.ts$', reason: 'NestJS class file' }] },
      imports: {
        mode: 'allowlist',
        allow: ['decimal.js', { module: '@prisma/client', names: ['Prisma'] }],
      },
      ...extra,
    });

  it('allows relative imports, aliases, listed packages, listed names and type imports', () => {
    expect(
      gate(
        [
          "import Decimal from 'decimal.js';",
          "import { Prisma } from '@prisma/client';",
          "import { round } from './round';",
          "import { tax } from '@/common/tax';",
          "import type { Request } from 'express';",
          "import type Stripe from 'stripe';",
          "export type { Dayjs } from 'dayjs';",
        ].join('\n'),
        allowlist()
      )
    ).toEqual([]);
  });

  it('rejects a package that is not listed, however harmless', () => {
    expect(gate("import dayjs from 'dayjs';\nimport path from 'node:path';", allowlist())).toEqual([
      {
        file: GATE,
        line: 1,
        message:
          'runtime import of "dayjs" is not in settings.imports.allow (allowlist mode allows relative imports, import aliases and listed packages only)',
      },
      {
        file: GATE,
        line: 2,
        message:
          'runtime import of "node:path" is not in settings.imports.allow (allowlist mode allows relative imports, import aliases and listed packages only)',
      },
    ]);
  });

  it('rejects require() and import() of an unlisted package too', () => {
    const violations = gate(
      "const a = require('lodash');\nconst b = await import('zod');",
      allowlist()
    );
    expect(violations.map((violation) => violation.line)).toEqual([1, 2]);
  });

  it('rejects a name that is not listed for its module', () => {
    expect(gate("import { Prisma, Role } from '@prisma/client';", allowlist())).toEqual([
      {
        file: GATE,
        line: 1,
        message:
          'runtime import of Role from "@prisma/client" is not in settings.imports.allow (allowed: Prisma)',
      },
    ]);
  });

  it('keeps the blocklist rules, and reports an import they reject only once', () => {
    expect(
      gate(
        "import { PrismaClient } from '@prisma/client';\nimport React from 'react';",
        allowlist()
      )
    ).toEqual([
      {
        file: GATE,
        line: 1,
        message: 'runtime use of PrismaClient from "@prisma/client" (connects to the database)',
      },
      { file: GATE, line: 2, message: 'runtime import of "react" (React runtime)' },
    ]);
  });

  it('keeps the blocklist rules for project imports', () => {
    const settings = allowlist({
      impureImports: { add: [{ pattern: '(^|/)repository(/|$)', reason: 'DB layer' }] },
    });
    expect(gate("import { find } from './repository/user';", settings)).toEqual([
      { file: GATE, line: 1, message: 'runtime import of "./repository/user" (DB layer)' },
    ]);
  });

  it('rejects a project import whose target could not be a gate', () => {
    expect(
      gate(
        "import { UserService } from './user.service';\nimport { x } from '@/orders/order.service';\nimport { y } from './user-service';",
        allowlist()
      )
    ).toEqual([
      { file: GATE, line: 1, message: 'runtime import of "./user.service" (NestJS class file)' },
      {
        file: GATE,
        line: 2,
        message: 'runtime import of "@/orders/order.service" (NestJS class file)',
      },
    ]);
  });

  it('rejects an import whose specifier is computed', () => {
    expect(
      gate(
        'const name = pick();\nconst a = require(name);\nconst b = await import(name);',
        allowlist()
      )
    ).toEqual([
      {
        file: GATE,
        line: 2,
        message:
          'require() / import() with a computed specifier cannot be checked (allowlist mode)',
      },
      {
        file: GATE,
        line: 3,
        message:
          'require() / import() with a computed specifier cannot be checked (allowlist mode)',
      },
    ]);
  });

  it('does none of this in blocklist mode', () => {
    const source =
      "import dayjs from 'dayjs';\nimport { UserService } from './user.service';\nconst a = require(name);";
    const settings = resolveSettings({
      impurePaths: { add: [{ pattern: '\\.service\\.ts$', reason: 'NestJS class file' }] },
      imports: { allow: ['decimal.js'] },
    });
    expect(gate(source, settings)).toEqual([]);
    expect(gate(source)).toEqual([]);
  });
});
