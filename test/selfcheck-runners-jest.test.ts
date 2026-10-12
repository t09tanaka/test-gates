import { afterAll } from 'vitest';
import { cleanup } from './helpers';
import { jobsTests, sharedRunTests } from './support/selfcheck-runners';

afterAll(cleanup);

sharedRunTests('jest');
jobsTests('jest');
