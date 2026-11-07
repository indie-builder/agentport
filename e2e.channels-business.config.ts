import type { E2EConfig } from 'e2e';
import base from './e2e.config.js';

if (!process.env.E2E_APP_URL) {
  throw new Error('E2E_APP_URL is required for the channels business dataset');
}

export default {
  ...base,
  tests: ['tests/support/auth.e2e.ts', 'tests/channels-business.e2e.ts'],
  output: '.e2e/channels-business',
} satisfies E2EConfig;
