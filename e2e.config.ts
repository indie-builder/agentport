import { web } from '@e2e-dev/web';
import type { E2EConfig } from 'e2e';

/**
 * PACE 的 e2e 配置。与既有 Playwright 套件并存：
 * - Playwright 收集 `e2e/**\/*.spec.ts`
 * - e2e 收集 `tests/**\/*.e2e.ts`
 * 两者文件模式不重叠，可在迁移期同时跑。
 */
export default {
  tests: 'tests/**/*.e2e.ts',
  targets: [
    {
      name: 'web',
      engine: web({ viewport: { width: 1440, height: 900 } }),
      app: {
        url: 'http://localhost:5173',
        // 与 Playwright 的 webServer 一致：api(3000) + web(5173)。
        command: {
          executable: 'pnpm',
          args: ['dev'],
          env: { RATE_LIMIT_DISABLED: '1' },
          log: '.e2e/logs/app.log',
          reuseExisting: true,
        },
        readyUrl: 'http://localhost:5173',
      },
    },
  ],
  credentials: {
    admin: {
      username: process.env.E2E_ADMIN_USER ?? 'admin',
      password: () => process.env.E2E_ADMIN_PASSWORD ?? 'admin-local-dev-2026',
    },
  },
  reporters: ['list'],
  timeout: 120_000,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  output: '.e2e',
} satisfies E2EConfig;
