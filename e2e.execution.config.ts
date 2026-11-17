import type { E2EConfig } from 'e2e';
import base from './e2e.config.js';

export default {
  ...base,
  tests: [
    'tests/support/auth.e2e.ts',
    'tests/eval-execution.e2e.ts',
    'tests/runtime-build.e2e.ts',
    'tests/data-domain-execution.e2e.ts',
    'tests/agent-publish.e2e.ts',
    'tests/schedule-lifecycle.e2e.ts',
    'tests/governance.e2e.ts',
  ],
} satisfies E2EConfig;
