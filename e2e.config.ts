import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { web } from '@e2e-dev/web';
import type { E2EConfig } from 'e2e';

/** 未配置的 secret 在 workflow 里展开成空串；空串/纯空白一律当作未设置。 */
function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

const apiKey = env('ANTHROPIC_API_KEY');
const authToken = env('ANTHROPIC_AUTH_TOKEN');
const baseUrl = env('ANTHROPIC_BASE_URL');
const modelId = env('E2E_MODEL') ?? 'claude-sonnet-5-5';

// 空凭据只会让真实模型断言以难懂的方式超时；在加载配置时直接报清楚。
if (process.env.E2E_FULL === '1' && !apiKey && !authToken) {
  throw new Error(
    'E2E_FULL=1 需要 ANTHROPIC_API_KEY 或 ANTHROPIC_AUTH_TOKEN（空字符串按未设置处理）。',
  );
}

// provider 在未传 baseURL 时会重读 ANTHROPIC_BASE_URL；空串会直接报错，所以明确给默认值。
const ANTHROPIC_DEFAULT_BASE_URL = 'https://api.anthropic.com';

function anthropicModel(baseURL: string = ANTHROPIC_DEFAULT_BASE_URL) {
  return createAnthropic({
    baseURL,
    // createAnthropic 只接受一种认证方式；两者都有时优先官方 API key。
    ...(apiKey ? { apiKey } : authToken ? { authToken } : { apiKey: 'unused' }),
  }).languageModel(modelId);
}

/**
 * 官方端点只支持 Anthropic Messages，自建网关走 OpenAI-compatible；
 * 同一个 ANTHROPIC_BASE_URL 因此要按 host 选适配器，不能一律加 /v1。
 */
function agentModel() {
  if (baseUrl === undefined) return anthropicModel();

  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error(`ANTHROPIC_BASE_URL 不是合法 URL：${baseUrl}`);
  }

  if (url.hostname === 'api.anthropic.com') {
    // Anthropic provider 的 baseURL 是 API 前缀（默认以 /v1 结尾）。
    const baseURL = url.pathname === '/' ? `${url.origin}/v1` : baseUrl.replace(/\/+$/, '');
    return anthropicModel(baseURL);
  }

  const root = baseUrl.replace(/\/+$/, '');
  return createOpenAICompatible({
    name: 'anthropic-proxy',
    baseURL: root.endsWith('/v1') ? root : `${root}/v1`,
    apiKey: authToken ?? apiKey ?? 'unused',
  }).chatModel(modelId);
}

const model = agentModel();

export default {
  tests: 'tests/**/*.e2e.ts',
  targets: [
    {
      name: 'web',
      engine: web({ viewport: { width: 1440, height: 900 } }),
      app: {
        url: 'http://localhost:5173',
        command: {
          executable: 'pnpm',
          args: ['--filter', '@agentport/web', 'dev'],
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
      model,
      system: 'You are a careful QA agent. Verify every outcome on screen before finishing.',
    },
  },
  reporters: ['list'],
  timeout: 120_000,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  output: '.e2e',
} satisfies E2EConfig;
