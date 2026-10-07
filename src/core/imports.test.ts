import { describe, expect, it } from 'vitest';
import { parseImports } from './imports';

const one = (source: string) => {
  const imports = parseImports(source);
  expect(imports).toHaveLength(1);
  return imports[0]!;
};

describe('parseImports', () => {
  it('reads a named import', () => {
    expect(one(`import { a, b } from 'x';`)).toEqual({
      module: 'x',
      line: 1,
      typeOnly: false,
      names: ['a', 'b'],
      whole: false,
    });
  });

  it('reports the imported name, not the alias', () => {
    expect(one(`import { PrismaClient as Db } from "@prisma/client";`).names).toEqual([
      'PrismaClient',
    ]);
  });

  it('marks `import type` as type only', () => {
    expect(one(`import type { Request } from 'express';`)).toMatchObject({
      module: 'express',
      typeOnly: true,
    });
    expect(one(`import type Stripe from 'stripe';`).typeOnly).toBe(true);
  });

  it('leaves inline type names out but keeps the import a runtime import', () => {
    expect(one(`import { type A, b, type C as D } from 'x';`)).toMatchObject({
      typeOnly: false,
      names: ['b'],
      whole: false,
    });
  });

  it('keeps a name that merely starts with "type"', () => {
    expect(one(`import { typeOf, types } from 'x';`).names).toEqual(['typeOf', 'types']);
  });

  it.each([
    [`import React from 'react';`, 'react', []],
    [`import * as ns from 'x';`, 'x', []],
    [`import d, { a } from 'x';`, 'x', ['a']],
    [`import d, * as ns from 'x';`, 'x', []],
    [`export * from 'x';`, 'x', []],
    [`export * as ns from 'x';`, 'x', []],
  ])('marks %s as reaching the whole module', (source, module, names) => {
    expect(one(source)).toEqual({ module, line: 1, typeOnly: false, names, whole: true });
  });

  it('reads a re-export and a type-only re-export', () => {
    expect(one(`export { a as b } from './a';`)).toMatchObject({
      module: './a',
      typeOnly: false,
      names: ['a'],
      whole: false,
    });
    expect(one(`export type { A } from './a';`).typeOnly).toBe(true);
  });

  it('reads a side-effect import', () => {
    expect(one(`import 'server-only';`)).toEqual({
      module: 'server-only',
      line: 1,
      typeOnly: false,
      names: [],
      whole: false,
    });
  });

  it.each([
    [`const fs = require('node:fs');`, 'node:fs'],
    [`const x = await import("./lazy");`, './lazy'],
    ['const y = require(`pg`);', 'pg'],
    [`import fs = require('fs');`, 'fs'],
  ])('reads %s as a whole-module runtime import', (source, module) => {
    expect(one(source)).toEqual({ module, line: 1, typeOnly: false, names: [], whole: true });
  });

  it('reads a multi-line import and reports the line of the specifier', () => {
    const source = ['// header', 'import {', '  a,', '  type B,', '  c,', "} from './abc';"].join(
      '\n'
    );
    expect(one(source)).toEqual({
      module: './abc',
      line: 6,
      typeOnly: false,
      names: ['a', 'c'],
      whole: false,
    });
  });

  it('reads several statements, one per line or separated by semicolons', () => {
    const source = [
      `import a from 'a'; import { b } from 'b'`,
      `import type { C } from 'c'`,
      `  export { d } from 'd'`,
      `const e = require('e')`,
    ].join('\n');
    expect(parseImports(source).map(({ module, line }) => [module, line])).toEqual([
      ['a', 1],
      ['b', 1],
      ['c', 2],
      ['d', 3],
      ['e', 4],
    ]);
  });

  it('does not run across statements to find a "from"', () => {
    const source = [
      'export const from = 1;',
      'export function f() { return from; }',
      "import type { T } from 'types';",
    ].join('\n');
    expect(parseImports(source)).toEqual([
      { module: 'types', line: 3, typeOnly: true, names: ['T'], whole: false },
    ]);
  });

  it('does not read a plain string or a method named import', () => {
    expect(parseImports(`const s = "from 'x'"; obj.import_('y'); const from = 'z';`)).toEqual([]);
  });

  it('returns nothing for a file without imports', () => {
    expect(parseImports('export const a = 1;\n')).toEqual([]);
  });
});
