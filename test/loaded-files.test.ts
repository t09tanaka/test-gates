import { afterAll, describe, expect, it } from 'vitest';
import { loadedFiles } from '../src/commands/loaded-files';
import { readManifest } from '../src/load';
import { cleanup, project } from './helpers';

afterAll(cleanup);

const gate = (file: string) => ({ path: file, decides: 'a price', impact: 'a wrong price' });

describe('loadedFiles', () => {
  it('follows the imports of a component a spec loads, and takes the spec for one that may load any gate', () => {
    const dir = project({
      'test-gates.json': { gates: [gate('src/fee.ts'), gate('src/tax.ts')], candidates: [] },
      'src/fee.ts': 'export const fee = (x: number) => x + 1;\n',
      'src/fee.spec.ts': "import { fee } from './fee';\nit('fee', () => expect(fee(1)).toBe(2));\n",
      'src/tax.ts': 'export const tax = (x: number) => x * 2;\n',
      'src/tax.spec.ts':
        "import { tax } from './tax';\nimport Comp from './Comp.vue';\nit('tax', () => expect(tax(1) && Comp).toBeTruthy());\n",
      'src/Comp.vue': '<script setup lang="ts">\nimport { fee } from \'./fee\';\n</script>\n',
      'src/data.json': '{}',
    });
    const { roots } = loadedFiles(readManifest(dir), null);
    const tax = roots.find((root) => root.spec === 'src/tax.spec.ts');
    // It may load any gate besides: a component can use others that it does not import.
    expect(tax?.lost).toBe(
      'src/Comp.vue is a component, which can use others that it does not import'
    );
    expect(tax?.files).toEqual(['src/tax.spec.ts', 'src/tax.ts', 'src/Comp.vue', 'src/fee.ts']);
  });

  it('follows both scripts of one name, as the runner may take either', () => {
    const dir = project({
      'test-gates.json': { gates: [gate('src/fee.ts')], candidates: [] },
      'src/fee.ts': "import { rate } from './rate';\nexport const fee = (x: number) => x + rate;\n",
      'src/fee.spec.ts': "import { fee } from './fee';\nit('fee', () => expect(fee(1)).toBe(2));\n",
      'src/rate.ts': 'export const rate: number = 1;\n',
      'src/rate.js': 'export const rate = 1;\n',
    });
    const { roots } = loadedFiles(readManifest(dir), null);
    expect(roots.find((root) => root.spec === 'src/fee.spec.ts')?.files).toEqual([
      'src/fee.spec.ts',
      'src/fee.ts',
      'src/rate.ts',
      'src/rate.js',
    ]);
  });
});
