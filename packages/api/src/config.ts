import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  PORT: z.coerce.number().int().positive().default(3000),
  /** 平台自身可达地址，用于 generated server 的 MCP 端点自测 */
  SELF_URL: z.string().default('http://127.0.0.1:3000'),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1).default('redis://localhost:6379'),
  APP_SECRET_KEY: z.string().min(16),
  ADMIN_USER: z.string().default('admin'),
  ADMIN_PASSWORD: z.string().min(8),
  JWT_SECRET: z.string().min(16),
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
