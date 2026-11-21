import { web } from '@e2e-dev/web';
import type { E2EConfig } from 'e2e';

const appUrl = process.env.E2E_APP_URL;
if (!appUrl) {
  throw new Error(
    'E2E_APP_URL is required for the dev dataset: point it at the prepared app instance',
  );
}

export default {
  tests: ['tests/support/auth.e2e.ts', 'tests/dev-data/**/*.e2e.ts'],
  targets: [
    {
      name: 'web',
      engine: web({ viewport: { width: 1440, height: 900 } }),
      app: { url: appUrl },
    },
  ],
  credentials: {
    admin: {
      username: process.env.E2E_ADMIN_USER ?? 'admin',
      password: () => process.env.E2E_ADMIN_PASSWORD ?? 'admin-local-dev-2026',
    },
  },
  reporters: ['list'],
  timeout: 180_000,
  retries: 0,
  workers: 1,
  output: '.e2e/dev-data',
} satisfies E2EConfig;
