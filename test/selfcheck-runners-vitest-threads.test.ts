import { afterAll } from 'vitest';
import { cleanup } from './helpers';
import { sharedRunTests } from './support/selfcheck-runners';

afterAll(cleanup);

sharedRunTests('vitest in threads');
