import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { web } from '@e2e-dev/web';
import type { E2EConfig } from 'e2e';

/**
 * Agent 步骤用的模型。项目已有 Anthropic 直连配置（ANTHROPIC_BASE_URL +
 * ANTHROPIC_AUTH_TOKEN），这里用 OpenAI-compatible 构造函数复用同一端点，
 * 避免再要求一个 ANTHROPIC_API_KEY。
 */
const anthropic = createOpenAICompatible({
  name: 'anthropic-proxy',
  baseURL: `${process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com'}/v1`,
  apiKey: process.env.ANTHROPIC_AUTH_TOKEN ?? process.env.ANTHROPIC_API_KEY ?? '',
});

/** 指向已起好的独立实例（如 3305）时不带 command；默认仍是本地 vite。 */
const externalAppUrl = process.env.E2E_APP_URL;

export default {
  // 持久开发数据集只在 e2e.dev-data.config.ts 里收集，普通回归不跑。
  tests: ['tests/**/*.e2e.ts', '!tests/dev-data/**'],
  targets: [
    {
      name: 'web',
      engine: web({ viewport: { width: 1440, height: 900 } }),
      app: externalAppUrl
        ? { url: externalAppUrl }
        : {
            url: 'http://localhost:5173',
            command: {
              executable: 'pnpm',
              // 直接跑 vite：Portless 只用于本地启动，CI 非 TTY 环境起不了代理
              args: ['--filter', '@agentport/web', 'exec', 'vite'],
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
  agents: {
    default: {
      model: anthropic.chatModel(process.env.E2E_MODEL ?? 'claude-sonnet-5-5'),
      system: 'You are a careful QA agent. Verify every outcome on screen before finishing.',
    },
  },
  reporters: ['list'],
  timeout: 120_000,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  output: '.e2e',
} satisfies E2EConfig;
