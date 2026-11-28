import { z } from 'zod';

export const DEFAULT_SANDBOX_API_URL = 'http://host.docker.internal:3000';
export const DEFAULT_SANDBOX_MAX_FIELD_BYTES = 1024 * 1024;

export const commonEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  REDIS_URL: z.string().min(1).default('redis://localhost:6379'),
});

export const serviceEnvShape = {
  DATABASE_URL: z.string().min(1),
  APP_SECRET_KEY: z.string().min(32),
  ANTHROPIC_BASE_URL: z.string().optional(),
  WREN_RUNTIME_URL: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.string().url().default(''),
  ),
  SANDBOX_IMAGE: z.string().min(1).default('agentport/sandbox:dev'),
  /** 与宿主机同一路径：worker 把该目录挂进沙盒，路径必须对宿主 daemon 有效。 */
  WORKSPACES_DIR: z.string().min(1).default('./data/workspaces'),
  KNOWLEDGE_DIR: z.string().min(1).default('./data/knowledge'),
  KNOWLEDGE_PRIVATE_HOST_ALLOWLIST: z.string().default(''),
  MODEL_PROVIDER_PRIVATE_HOST_ALLOWLIST: z.string().default(''),
  WEBHOOK_PRIVATE_HOST_ALLOWLIST: z.string().default(''),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
};

export function parseEnv<S extends z.ZodType>(
  schema: S,
  env: Record<string, string | undefined>,
): z.output<S> {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment:\n${detail}`);
  }
  return parsed.data;
}
