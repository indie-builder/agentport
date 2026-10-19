import { z } from 'zod';

/** 常见弱默认口令：本地开发也不允许，避免配置被原样带到部署环境。 */
const WEAK_PASSWORDS = new Set(['admin-change-me', 'changeme', 'password']);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  PORT: z.coerce.number().int().positive().default(3000),
  /** 平台自身可达地址，用于 generated server 的 MCP 端点自测 */
  SELF_URL: z.string().default('http://127.0.0.1:3000'),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1).default('redis://localhost:6379'),
  APP_SECRET_KEY: z.string().min(32),
  ADMIN_USER: z.string().default('admin'),
  ADMIN_PASSWORD: z
    .string()
    .min(12)
    .refine((value) => !WEAK_PASSWORDS.has(value), 'must not be a well-known default password'),
  JWT_SECRET: z.string().min(32),
  AGENT_DEFAULT_MODEL: z.string().default('claude-sonnet-5-5'),
  AGENT_MAX_CONCURRENT: z.coerce.number().int().positive().default(2),
  AGENT_TIMEOUT_MS: z.coerce.number().int().positive().default(600_000),
  AGENT_MAX_BUDGET_USD: z.coerce.number().positive().default(2),
});

export type Config = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment:\n${detail}`);
  }
  return parsed.data;
}
