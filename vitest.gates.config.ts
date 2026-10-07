// Gate run of test-gates itself. The list of gates lives in test-gates.json.
import { defineConfig } from 'vitest/config';
import { createVitestGatesConfig } from './src/vitest';

export default defineConfig(createVitestGatesConfig({ rootDir: import.meta.url }));
