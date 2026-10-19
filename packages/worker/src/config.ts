import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1).default('redis://localhost:6379'),
  /** 与宿主机同一路径：worker 把该目录挂进沙盒，路径必须对宿主 daemon 有效。 */
  WORKSPACES_DIR: z.string().min(1).default('./data/workspaces'),
  /**
   * 宿主视角的 WORKSPACES_DIR。容器部署时 WORKSPACES_DIR 是命名卷挂载点（如 /workspaces），
   * 而 docker -v 的源路径由宿主 daemon 解析，必须换成该卷的宿主目录。默认与 WORKSPACES_DIR 相同。
   */
  HOST_WORKSPACES_DIR: z.string().min(1).optional(),
  SANDBOX_IMAGE: z.string().min(1).default('agentport/sandbox:dev'),
  /** open=bridge；none=断网；proxy=仍用 bridge，由 HTTPS_PROXY 指向宿主代理。 */
  SANDBOX_EGRESS: z.enum(['open', 'none', 'proxy']).default('proxy'),
  SANDBOX_MEMORY: z
    .string()
    .regex(/^[1-9]\d*[bkmg]?$/i, 'expected a docker memory value such as 1g')
    .default('1g'),
  SANDBOX_CPUS: z.coerce.number().positive().default(1),
  SANDBOX_PIDS: z.coerce.number().int().positive().default(128),
  AGENT_MAX_CONCURRENT: z.coerce.number().int().positive().default(2),
  /** 维护任务的保留天数；0 不合法，要保留更久就调大。 */
  RETAIN_RUN_DAYS: z.coerce.number().int().positive().default(90),
  RETAIN_MESSAGE_DAYS: z.coerce.number().int().positive().default(30),
  RETAIN_AGENT_VERSIONS: z.coerce.number().int().positive().default(50),
  AGENT_TIMEOUT_MS: z.coerce.number().int().positive().default(600_000),
  SANDBOX_API_URL: z.string().min(1).default('http://host.docker.internal:3000'),
  /** 与 API 相同的密钥派生源：用来解密 server 的 env/headers 并注入工作区。 */
  APP_SECRET_KEY: z.string().min(32),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_AUTH_TOKEN: z.string().optional(),
  ANTHROPIC_BASE_URL: z.string().optional(),
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
